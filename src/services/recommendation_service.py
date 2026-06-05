# -*- coding: utf-8 -*-
"""
RecommendationService — 基于热门板块 + 技术评分的候选股推荐。

数据流：
1. 通过 DataFetcherManager.get_sector_rankings 拿今日领涨板块（已可达兜底）。
2. 候选池：HS300 成分（Tushare index_weight）和/或用户配置的 STOCK_LIST。
3. 用 Tushare 直连拉 30 日日 K，计算 MA5/10/20 / 动量 / 距 20 日高点 / 涨跌幅。
4. 命中热门板块（Tushare industry 与 eastmoney 板块名做模糊匹配）加分。
5. 排序输出，并写入 reports/recommendations_*.md。

不调用 LLM；如需对候选股出完整 AI 决策报告，运行 `python main.py --stocks <代码列表>`。
"""
from __future__ import annotations

import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from data_provider import DataFetcherManager

logger = logging.getLogger(__name__)

HS300_INDEX_CODE = "000300.SH"


@dataclass
class CandidateScore:
    code: str
    name: str = ""
    industry: Optional[str] = None
    last_price: float = 0.0
    change_pct: float = 0.0
    score: int = 0
    signals: List[str] = field(default_factory=list)
    sector_match: Optional[str] = None


def _load_tushare_pro():
    token = (os.environ.get("TUSHARE_TOKEN") or "").strip()
    if not token:
        return None
    try:
        import tushare as ts
        ts.set_token(token)
        return ts.pro_api()
    except Exception as e:
        logger.warning(f"[Recommend] Tushare 初始化失败: {e}")
        return None


def _to_ts_code(symbol: str) -> Optional[str]:
    """6 位 A 股代码 -> Tushare ts_code (e.g. 600519 -> 600519.SH)."""
    s = (symbol or "").strip()
    if not s.isdigit() or len(s) != 6:
        return None
    if s.startswith(("60", "68", "11", "9")):
        return f"{s}.SH"
    if s.startswith(("00", "30")):
        return f"{s}.SZ"
    if s.startswith(("4", "8", "92")):
        return f"{s}.BJ"
    return None


def _get_hs300_codes(pro) -> List[str]:
    """HS300 成分 6 位代码列表;Tushare 限流时回退到 akshare。"""
    # 优先 Tushare
    if pro is not None:
        try:
            df = pro.index_weight(index_code=HS300_INDEX_CODE)
            if df is not None and not df.empty:
                codes = sorted({str(c).split(".")[0] for c in df["con_code"].dropna()})
                logger.info(f"[Recommend] 取 HS300 成分 {len(codes)} 只 (Tushare)")
                return codes
        except Exception as e:
            logger.warning(f"[Recommend] Tushare index_weight 失败: {e},尝试 akshare 兜底")

    # akshare 兜底
    try:
        import akshare as ak
        df = ak.index_stock_cons(symbol="000300")
        if df is not None and not df.empty:
            col = next((c for c in df.columns if str(c) in {"品种代码", "代码", "code"}), None)
            if col is None:
                return []
            codes = sorted({str(c).strip().zfill(6) for c in df[col].dropna()})
            logger.info(f"[Recommend] 取 HS300 成分 {len(codes)} 只 (akshare 兜底)")
            return codes
    except Exception as e:
        logger.warning(f"[Recommend] akshare index_stock_cons 兜底失败: {e}")

    return []


def _safe_get_name(manager: DataFetcherManager, code: str) -> str:
    """通过 DataFetcherManager 兜底取股票名,失败返回空串。"""
    try:
        name = manager.get_stock_name(code, allow_realtime=False)
        return str(name or "").strip()
    except Exception:
        return ""


_STOCK_BASIC_CACHE_PATH = Path("data/stock_basic_cache.json")
_STOCK_BASIC_TTL = 24 * 3600  # 行业/名称基本静态,缓存一天即可
# 进程内缓存,避免每次荐股都读盘
_STOCK_BASIC_MEM: Dict[str, Any] = {"ts": 0.0, "industry": {}, "name": {}}


def _read_stock_basic_cache(ignore_ttl: bool = False) -> Optional[Tuple[Dict[str, str], Dict[str, str]]]:
    """读 stock_basic 缓存(内存优先,再落盘)。ignore_ttl=True 时即使过期也返回(兜底)。"""
    import time

    now = time.time()
    if _STOCK_BASIC_MEM["name"] and (ignore_ttl or now - _STOCK_BASIC_MEM["ts"] < _STOCK_BASIC_TTL):
        return _STOCK_BASIC_MEM["industry"], _STOCK_BASIC_MEM["name"]
    try:
        if _STOCK_BASIC_CACHE_PATH.exists():
            import json

            data = json.loads(_STOCK_BASIC_CACHE_PATH.read_text(encoding="utf-8"))
            if data.get("name") and (ignore_ttl or now - float(data.get("ts", 0)) < _STOCK_BASIC_TTL):
                _STOCK_BASIC_MEM.update(ts=float(data.get("ts", 0)), industry=data.get("industry", {}), name=data.get("name", {}))
                return _STOCK_BASIC_MEM["industry"], _STOCK_BASIC_MEM["name"]
    except Exception as e:
        logger.debug(f"[Recommend] 读 stock_basic 缓存失败: {e}")
    return None


def _write_stock_basic_cache(industry: Dict[str, str], name: Dict[str, str]) -> None:
    import json
    import time

    _STOCK_BASIC_MEM.update(ts=time.time(), industry=industry, name=name)
    try:
        _STOCK_BASIC_CACHE_PATH.parent.mkdir(exist_ok=True)
        _STOCK_BASIC_CACHE_PATH.write_text(
            json.dumps({"ts": _STOCK_BASIC_MEM["ts"], "industry": industry, "name": name}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as e:
        logger.debug(f"[Recommend] 写 stock_basic 缓存失败: {e}")


def _get_stock_basic_maps(pro) -> Tuple[Dict[str, str], Dict[str, str]]:
    """(industry_map, name_map),key 是 6 位 symbol。

    stock_basic 接口限频(部分套餐 1 次/小时),而行业/名称基本静态,
    因此带 24h 磁盘缓存:一天取一次、复用全天;限频/失败时回退旧缓存。
    """
    cached = _read_stock_basic_cache()
    if cached is not None:
        return cached
    if pro is None:
        return {}, {}
    try:
        df = pro.stock_basic(
            exchange="",
            list_status="L",
            fields="symbol,name,industry",
        )
        industry = {str(s): str(i or "") for s, i in zip(df["symbol"], df["industry"])}
        name = {str(s): str(n) for s, n in zip(df["symbol"], df["name"])}
        _write_stock_basic_cache(industry, name)
        logger.info(f"[Recommend] stock_basic 已刷新并缓存: {len(name)} 只")
        return industry, name
    except Exception as e:
        logger.warning(f"[Recommend] 获取 stock_basic 失败: {e}")
        # 限频/失败时回退到过期缓存(若有),避免丢失行业/名称
        stale = _read_stock_basic_cache(ignore_ttl=True)
        if stale is not None:
            logger.info("[Recommend] stock_basic 复用过期缓存兜底")
            return stale
        return {}, {}


def _fetch_daily(pro, symbol: str, days: int = 30) -> Optional[pd.DataFrame]:
    """通过 Tushare 拉单股近 N 日日 K,返回按日期升序的 DataFrame。"""
    ts_code = _to_ts_code(symbol)
    if not ts_code or pro is None:
        return None
    try:
        end = datetime.now().strftime("%Y%m%d")
        start = (datetime.now() - timedelta(days=days * 2 + 10)).strftime("%Y%m%d")
        df = pro.daily(ts_code=ts_code, start_date=start, end_date=end)
        if df is None or df.empty:
            return None
        df = df.sort_values("trade_date").reset_index(drop=True)
        # 统一字段名,方便评分
        df = df.rename(columns={
            "trade_date": "date",
            "vol": "volume",
        })
        df["code"] = symbol
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        df["high"] = pd.to_numeric(df["high"], errors="coerce")
        df["volume"] = pd.to_numeric(df["volume"], errors="coerce")
        df["pct_chg"] = pd.to_numeric(df["pct_chg"], errors="coerce")
        df["ma5"] = df["close"].rolling(5).mean()
        df["ma10"] = df["close"].rolling(10).mean()
        df["ma20"] = df["close"].rolling(20).mean()
        # 量比 = 当日成交量 / 过去 5 日均量
        vol_ma5 = df["volume"].rolling(5).mean()
        df["volume_ratio"] = (df["volume"] / vol_ma5).round(2)
        return df.tail(days).reset_index(drop=True)
    except Exception as e:
        logger.debug(f"[Recommend] {symbol} Tushare daily 失败: {e}")
        return None


def _get_recent_trade_dates(
    pro,
    n: int = 30,
    *,
    min_required: int = 20,
    max_attempts: int = 3,
) -> List[str]:
    """取最近 n 个开市交易日(升序),用于全市场批量取数。

    用一只始终交易的权重股(平安银行 000001.SZ)的日 K 反推交易日,
    避免 Tushare trade_cal 接口的低频限制(部分套餐 1 次/小时)。

    Tushare 限频时该接口可能返回被截断的结果(例如仅 1 行)而**不报错**,
    会导致全市场面板按极少天数构建、所有个股因不足 20 日被跳过 → 候选池为空。
    因此当拿到的交易日数明显不足(< min_required)时重试几次;若多次仍不足,
    返回已有结果,由调用方据此判定为数据源不可用(而非"今日无符合候选")。
    """
    import time

    last: List[str] = []
    for attempt in range(1, max_attempts + 1):
        try:
            end = datetime.now().strftime("%Y%m%d")
            start = (datetime.now() - timedelta(days=n * 2 + 40)).strftime("%Y%m%d")
            df = pro.daily(ts_code="000001.SZ", start_date=start, end_date=end)
            if df is not None and not df.empty:
                dates = sorted(str(d) for d in df["trade_date"].dropna().tolist())
                last = dates[-n:]
                if len(last) >= min(n, min_required):
                    return last
                logger.warning(
                    "[Recommend] 交易日仅取到 %d 个(期望≥%d),疑似 Tushare 限频截断,重试 %d/%d",
                    len(last), min(n, min_required), attempt, max_attempts,
                )
        except Exception as e:
            logger.warning(f"[Recommend] 交易日列表获取失败(第 {attempt} 次): {e}")
        if attempt < max_attempts:
            time.sleep(1.5 * attempt)
    return last


def _build_all_a_panel(pro, dates: List[str], emit=None) -> Dict[str, pd.DataFrame]:
    """按交易日批量拉全 A 股日 K(每日一次请求),返回 {6位代码: 评分用 DataFrame}。

    相比逐只拉取(5000+ 次请求),这里 ~30 次请求即可覆盖全市场。
    """
    import time

    frames: List[pd.DataFrame] = []
    total = len(dates)
    for i, d in enumerate(dates, 1):
        if emit and (i % 5 == 0 or i == total):
            emit("fetch", i, total, f"拉取全市场日K {i}/{total}")
        try:
            df = pro.daily(trade_date=d)
            if df is not None and not df.empty:
                frames.append(df)
        except Exception as e:
            logger.warning(f"[Recommend] daily(trade_date={d}) 失败: {e}")
        time.sleep(0.12)  # 轻量限速,避免 Tushare 触发频控

    if not frames:
        return {}

    big = pd.concat(frames, ignore_index=True)
    big = big.rename(columns={"trade_date": "date", "vol": "volume"})
    for col in ("close", "high", "volume", "pct_chg"):
        big[col] = pd.to_numeric(big.get(col), errors="coerce")
    big["code"] = big["ts_code"].astype(str).str.split(".").str[0]
    big = big.sort_values(["code", "date"])

    out: Dict[str, pd.DataFrame] = {}
    for code, g in big.groupby("code", sort=False):
        if len(g) < 20:  # 次新股/数据不足,跳过(与 _score_stock 的最小长度一致)
            continue
        g = g.reset_index(drop=True)
        g["ma5"] = g["close"].rolling(5).mean()
        g["ma10"] = g["close"].rolling(10).mean()
        g["ma20"] = g["close"].rolling(20).mean()
        vol_ma5 = g["volume"].rolling(5).mean()
        g["volume_ratio"] = (g["volume"] / vol_ma5).round(2)
        out[code] = g.tail(30).reset_index(drop=True)
    logger.info(f"[Recommend] 全 A 股面板构建完成: {len(out)} 只(覆盖 {len(frames)}/{total} 个交易日)")
    return out


def _score_stock(df: pd.DataFrame) -> Optional[CandidateScore]:
    """对单股日 K 做技术评分。"""
    if df is None or len(df) < 20:
        return None
    last = df.iloc[-1]
    close = float(last.get("close") or 0)
    if close <= 0:
        return None

    score = 0
    signals: List[str] = []

    # 1. MA 排列(权重 30)
    ma5 = last.get("ma5")
    ma10 = last.get("ma10")
    ma20 = last.get("ma20")
    if pd.notna(ma5) and pd.notna(ma10) and pd.notna(ma20):
        if ma5 > ma10 > ma20:
            score += 30
            signals.append("多头排列")
        elif ma5 > ma10:
            score += 10
            signals.append("MA5>MA10")
        elif ma5 < ma10 < ma20:
            score -= 20
            signals.append("空头排列")

    # 2. 5 日动量(权重 ±15)
    if len(df) >= 6:
        prev = float(df.iloc[-6]["close"])
        if prev > 0:
            ret5 = (close - prev) / prev * 100
            if 0 < ret5 < 15:
                score += 15
                signals.append(f"5日{ret5:+.1f}%")
            elif ret5 >= 15:
                score -= 10
                signals.append(f"5日{ret5:+.1f}%(已涨多)")
            elif ret5 <= -5:
                score -= 10
                signals.append(f"5日{ret5:+.1f}%")

    # 3. 量比(权重 ±15)
    vol_ratio = last.get("volume_ratio")
    if pd.notna(vol_ratio):
        vr = float(vol_ratio)
        if 1.2 <= vr <= 3:
            score += 15
            signals.append(f"量比{vr:.2f}")
        elif vr > 3:
            score -= 5
            signals.append(f"量比{vr:.2f}(异常)")

    # 4. 距 20 日高点距离(权重 15,临近突破加分)
    high20 = df["high"].iloc[-20:].max()
    if pd.notna(high20) and high20 > 0:
        ratio = close / float(high20)
        if 0.95 <= ratio < 1.0:
            score += 15
            signals.append(f"距20日高{(1-ratio)*100:.1f}%")
        elif ratio < 0.85:
            score -= 5

    # 5. 临近涨停/跌停(惩罚追高)
    chg = float(last.get("pct_chg") or 0)
    if chg >= 9.5:
        score -= 15
        signals.append(f"今日{chg:+.1f}%(临近涨停)")

    return CandidateScore(
        code=str(last.get("code") or ""),
        last_price=close,
        change_pct=chg,
        score=score,
        signals=signals,
    )


def _match_sector(industry: Optional[str], sector_names: List[str]) -> Optional[str]:
    """Tushare industry 与 eastmoney 板块名模糊匹配:子串/关键字相交。"""
    if not industry:
        return None
    ind = industry.strip()
    for sector in sector_names:
        if not sector:
            continue
        sec = sector.strip()
        if ind in sec or sec in ind:
            return sec
        for ch_len in range(2, min(len(ind), len(sec)) + 1):
            for i in range(len(ind) - ch_len + 1):
                token = ind[i:i + ch_len]
                if token and token in sec:
                    return sec
    return None


def _build_pool(pool: str, hs300_codes: List[str], watchlist: List[str]) -> List[str]:
    pool = (pool or "hs300").lower()
    if pool == "hs300":
        codes = hs300_codes
    elif pool == "watchlist":
        codes = watchlist
    else:  # both
        codes = list(hs300_codes) + list(watchlist)
    # 去重保序 & 过滤合法 6 位 A 股
    seen: set = set()
    out: List[str] = []
    for c in codes:
        c = (c or "").strip()
        if c.isdigit() and len(c) == 6 and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _write_report(
    hot_sectors: List[str],
    candidates: List[CandidateScore],
    pool_label: str,
    pool_size: int,
    price_as_of: Optional[str] = None,
) -> Optional[Path]:
    return _render_and_save_markdown(hot_sectors, candidates, pool_label, pool_size, price_as_of)


def _render_recommendation_markdown(
    hot_sectors: List[str],
    candidates: List[CandidateScore],
    pool_label: str,
    pool_size: int,
    price_as_of: Optional[str] = None,
) -> str:
    lines = [
        f"# 📈 选股推荐 {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        f"候选池:{pool_label} (共 {pool_size} 只),按技术评分排序后输出 Top {len(candidates)}。",
        "",
        f"_现价/涨跌幅:实时报价 (as_of {price_as_of})_" if price_as_of else "_现价/涨跌幅:T-1 日 K 收盘_",
        "",
        "## 🔥 今日领涨板块 Top 5",
        "",
    ]
    if hot_sectors:
        for s in hot_sectors:
            lines.append(f"- {s}")
    else:
        lines.append("(未取到板块排行)")
    lines.extend([
        "",
        "## 🎯 候选股票",
        "",
        "| 排名 | 代码 | 名称 | 行业 | 评分 | 现价 | 涨跌幅 | 关键信号 |",
        "|---:|---|---|---|---:|---:|---:|---|",
    ])
    if not candidates:
        lines.append("| - | - | - | - | - | - | - | 无符合条件候选 |")
    for i, c in enumerate(candidates, 1):
        signals = " / ".join(c.signals) if c.signals else "-"
        lines.append(
            f"| {i} | {c.code} | {c.name or '-'} | {c.industry or '-'} | "
            f"{c.score} | {c.last_price:.2f} | {c.change_pct:+.2f}% | {signals} |"
        )
    lines.extend([
        "",
        "> 评分仅基于技术指标(MA 排列 / 5 日动量 / 量比 / 距 20 日高点 / 涨跌幅)+ 命中热门板块加成,",
        "> 不含基本面与新闻面分析。要对某只候选股出完整 AI 决策报告,运行:",
        ">",
        "> `python main.py --stocks <代码1>,<代码2> --no-notify`",
    ])
    return "\n".join(lines)


def _render_and_save_markdown(
    hot_sectors: List[str],
    candidates: List[CandidateScore],
    pool_label: str,
    pool_size: int,
    price_as_of: Optional[str] = None,
) -> Optional[Path]:
    try:
        reports_dir = Path("reports")
        reports_dir.mkdir(exist_ok=True)
        date_tag = datetime.now().strftime("%Y%m%d")
        path = reports_dir / f"recommendations_{date_tag}.md"
        markdown = _render_recommendation_markdown(hot_sectors, candidates, pool_label, pool_size, price_as_of)
        path.write_text(markdown, encoding="utf-8")
        logger.info(f"[Recommend] 报告已保存: {path}")
        return path
    except Exception as e:
        logger.warning(f"[Recommend] 写报告失败: {e}")
        return None


def recommend(
    top_n: int = 10,
    pool: str = "hs300",
    watchlist: Optional[List[str]] = None,
    progress_cb: Optional[Any] = None,
) -> Dict[str, Any]:
    """
    生成候选股推荐。

    progress_cb(stage: str, current: int, total: int, message: str) — 可选回调,
    用于把执行进度回传到 HTTP 长任务接口。
    """
    def _emit(stage: str, current: int = 0, total: int = 0, message: str = "") -> None:
        if progress_cb is None:
            return
        try:
            progress_cb(stage, current, total, message)
        except Exception:
            pass  # 进度回调失败不阻断主流程

    manager = DataFetcherManager()
    pro = _load_tushare_pro()
    if pro is None:
        logger.error("[Recommend] 未配置 TUSHARE_TOKEN,候选股推荐依赖 Tushare 拉数据/行业,无法继续")
        return {"hot_sectors": [], "candidates": [], "report_path": None}

    # 1. 热门板块
    _emit("sectors", 0, 0, "拉取今日领涨板块")
    try:
        top_sectors, _ = manager.get_sector_rankings(5)
        sector_names = [str(s.get("name") or "") for s in top_sectors if s.get("name")]
    except Exception as e:
        logger.warning(f"[Recommend] 板块排行获取失败: {e}")
        sector_names = []
    logger.info(f"[Recommend] 今日领涨板块: {sector_names}")

    # 2. 候选池
    _emit("pool", 0, 0, "构建候选股池")
    pool_norm = (pool or "hs300").lower()
    all_a_panel: Optional[Dict[str, pd.DataFrame]] = None
    if pool_norm == "all_a":
        # 全 A 股:按交易日批量拉全市场,避免逐只 5000+ 次请求
        _emit("fetch", 0, 0, "拉取全 A 股行情面板")
        trade_dates = _get_recent_trade_dates(pro, 30)
        all_a_panel = _build_all_a_panel(pro, trade_dates, _emit) if trade_dates else {}
        codes = list(all_a_panel.keys())
        pool_label = "ALL_A"
    else:
        hs300 = _get_hs300_codes(pro) if pool_norm in ("hs300", "both") else []
        user_list = list(watchlist or []) if pool_norm in ("watchlist", "both") else []
        codes = _build_pool(pool_norm, hs300, user_list)
        pool_label = {"hs300": "HS300", "watchlist": "WATCHLIST", "both": "HS300 + WATCHLIST"}.get(pool_norm, pool_norm)
    if not codes:
        # 全 A 股池为空 ≠ 今日无符合候选:全市场恒有数千只,空池只可能是
        # 交易日/面板取数失败(多为 Tushare 限频)。据此回传可区分的 status,
        # 让上层给出"数据源限频,请稍后重试"而非误导性的"未筛出候选"。
        if pool_norm == "all_a":
            logger.warning("[Recommend] 全 A 股面板为空,疑似 Tushare 限频/数据源暂不可用")
            status = "data_unavailable"
        else:
            logger.warning("[Recommend] 候选池为空")
            status = "empty_pool"
        _write_report(sector_names, [], pool_label, 0)
        return {
            "hot_sectors": sector_names,
            "candidates": [],
            "report_path": None,
            "status": status,
        }
    logger.info(f"[Recommend] 候选池 {pool_label}: {len(codes)} 只股票")

    # 3. 行业/名称 maps(Tushare 接口被限频时降级为空,用 manager 兜底取名)
    industry_map, name_map = _get_stock_basic_maps(pro)
    if not name_map:
        logger.info("[Recommend] Tushare stock_basic 不可用,将用 DataFetcherManager 兜底取股票名")

    # 4. 逐只评分
    candidates: List[CandidateScore] = []
    total = len(codes)
    for i, code in enumerate(codes, 1):
        if i % 20 == 0 or i == total:
            _emit("score", i, total, f"评分中 {i}/{total}")
        if i % 50 == 0 or i == total:
            logger.info(f"[Recommend] 评分进度 {i}/{total}")
        df = all_a_panel.get(code) if all_a_panel is not None else _fetch_daily(pro, code, days=30)
        cs = _score_stock(df)
        if cs is None:
            continue
        cs.code = code
        # 名称只用本地映射(批量),不在循环里逐只联网取名——
        # 全 A 股(5000+)逐只联网会拖到数小时。缺名的留到 Top N 再补。
        cs.name = name_map.get(code, "")
        cs.industry = industry_map.get(code, "")
        matched = _match_sector(cs.industry, sector_names)
        if matched:
            cs.sector_match = matched
            cs.score += 10
            cs.signals.append(f"热门板块:{matched}")
        candidates.append(cs)

    candidates.sort(key=lambda c: c.score, reverse=True)
    top = candidates[:top_n]
    logger.info(f"[Recommend] 评分完成,有效候选 {len(candidates)},输出 Top {len(top)}")

    # 仅对 Top N 补全缺失的股票名(联网兜底,N 次,代价可控)
    for c in top:
        if not c.name:
            c.name = _safe_get_name(manager, c.code)

    # 5. 用实时报价覆盖 Top N 的现价/涨跌幅(评分用日 K,展示用实时;失败回退)
    price_as_of = _enrich_with_realtime(manager, top)

    report_path = _write_report(sector_names, top, pool_label, len(codes), price_as_of)
    markdown = _render_recommendation_markdown(sector_names, top, pool_label, len(codes), price_as_of)

    # 6. 落库到 analysis_history(report_type=recommendation),让历史页能查看
    query_id = _persist_history(
        candidates=top,
        hot_sectors=sector_names,
        pool_label=pool_label,
        pool_size=len(codes),
        price_as_of=price_as_of,
        markdown=markdown,
    )

    return {
        "hot_sectors": sector_names,
        "candidates": [c.__dict__ for c in top],
        "report_path": str(report_path) if report_path else None,
        "pool_size": len(codes),
        "price_as_of": price_as_of,
        "query_id": query_id,
        "status": "ok",
    }


RECOMMENDATION_REPORT_TYPE = "recommendation"
RECOMMENDATION_HISTORY_CODE = "RECOMMENDATION"


def _persist_history(
    *,
    candidates: List[CandidateScore],
    hot_sectors: List[str],
    pool_label: str,
    pool_size: int,
    price_as_of: Optional[str],
    markdown: str,
) -> Optional[str]:
    """把荐股结果写到 analysis_history,统一走 history 列表/详情/markdown 接口。"""
    try:
        from src.analyzer import AnalysisResult
        from src.config import get_config
        from src.storage import DatabaseManager

        cfg = get_config()
        summary_lines: List[str] = []
        if hot_sectors:
            summary_lines.append("领涨板块: " + " / ".join(hot_sectors[:5]))
        if candidates:
            top_codes = ", ".join(f"{c.code}({c.score})" for c in candidates[:5])
            summary_lines.append(f"Top 候选: {top_codes}")
        summary_text = " · ".join(summary_lines) or f"{pool_label} 候选股推荐"

        result = AnalysisResult(
            code=RECOMMENDATION_HISTORY_CODE,
            name="候选股推荐",
            sentiment_score=50,
            trend_prediction=f"Top {len(candidates)}",
            operation_advice="查看候选",
            analysis_summary=summary_text[:500],
            report_language=getattr(cfg, "report_language", "zh"),
            news_summary=summary_text,
            raw_response=markdown,
            data_sources=RECOMMENDATION_REPORT_TYPE,
        )
        query_id = f"{RECOMMENDATION_REPORT_TYPE}_{uuid.uuid4().hex}"
        context: Dict[str, Any] = {
            "report_kind": RECOMMENDATION_REPORT_TYPE,
            "pool_label": pool_label,
            "pool_size": pool_size,
            "price_as_of": price_as_of,
            "hot_sectors": hot_sectors,
            "candidates": [c.__dict__ for c in candidates],
        }
        DatabaseManager.get_instance().save_analysis_history(
            result=result,
            query_id=query_id,
            report_type=RECOMMENDATION_REPORT_TYPE,
            news_content=summary_text,
            context_snapshot=context,
            save_snapshot=True,
        )
        logger.info(f"[Recommend] 已写入 history: query_id={query_id}")
        return query_id
    except Exception as e:
        logger.warning(f"[Recommend] 写入 history 失败: {e}", exc_info=True)
        return None


def _enrich_with_realtime(manager: DataFetcherManager, top: List[CandidateScore]) -> Optional[str]:
    """对 Top N 候选并行拉实时报价,覆盖 last_price/change_pct。返回最晚一次拿到行情的时间戳。"""
    if not top:
        return None
    as_of: Optional[str] = None

    def _fetch_one(c: CandidateScore) -> None:
        try:
            quote = manager.get_realtime_quote(c.code, log_final_failure=False)
            if quote is None:
                return
            price = getattr(quote, "price", None)
            chg = getattr(quote, "change_pct", None)
            if isinstance(price, (int, float)) and price > 0:
                c.last_price = float(price)
            if isinstance(chg, (int, float)):
                c.change_pct = float(chg)
        except Exception as e:
            logger.debug(f"[Recommend] {c.code} 实时报价取回失败: {e}")

    try:
        with ThreadPoolExecutor(max_workers=min(8, len(top))) as ex:
            list(ex.map(_fetch_one, top))
        as_of = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    except Exception as e:
        logger.warning(f"[Recommend] 实时报价批量覆盖失败,沿用日 K 收盘价: {e}")
    return as_of
