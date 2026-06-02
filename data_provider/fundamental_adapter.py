# -*- coding: utf-8 -*-
"""
AkShare fundamental adapter (fail-open).

This adapter intentionally uses capability probing against multiple AkShare
endpoint candidates. It should never raise to caller; partial data is allowed.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
import requests

logger = logging.getLogger(__name__)

_DIVIDEND_KEYWORD_MAP: Dict[str, List[str]] = {
    "per_share": [
        "每股派息",
        "每股现金红利",
        "每股分红",
        "每股派现",
        "派现(元/股)",
        "派息(元/股)",
        "税前派息(元/股)",
        "现金分红(税前)",
    ],
    "plan_text": [
        "分配方案",
        "分红方案",
        "实施方案",
        "派息方案",
        "方案",
        "预案",
        "方案说明",
    ],
    "ex_dividend_date": ["除权除息日", "除息日", "除权日", "除权除息", "除息日期"],
    "record_date": ["股权登记日", "登记日"],
    "announce_date": ["公告日期", "公告日", "实施公告日", "预案公告日"],
    "report_date": ["报告期", "报告日期", "截止日期", "统计截止日期"],
}


def _safe_float(value: Any) -> Optional[float]:
    """Best-effort float conversion."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    s = str(value).strip().replace(",", "").replace("%", "")
    if not s:
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _safe_datetime(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    try:
        parsed = pd.to_datetime(value)
    except Exception:
        return None
    if pd.isna(parsed):
        return None
    try:
        return parsed.to_pydatetime()
    except Exception:
        return None


def _normalize_code(raw: Any) -> str:
    s = _safe_str(raw).upper()
    if "." in s:
        s = s.split(".", 1)[0]
    s = re.sub(r"^(SH|SZ|BJ)", "", s)
    return s


def _pick_by_keywords(row: pd.Series, keywords: List[str]) -> Optional[Any]:
    """
    Return first non-empty row value whose column name contains any keyword.
    """
    for col in row.index:
        col_s = str(col)
        if any(k in col_s for k in keywords):
            val = row.get(col)
            if val is not None and str(val).strip() not in ("", "-", "nan", "None"):
                return val
    return None


def _parse_dividend_plan_to_per_share(plan_text: str) -> Optional[float]:
    """Parse per-share cash dividend from Chinese plan text."""
    text = _safe_str(plan_text)
    if not text:
        return None

    for pattern in (
        r"(?:每)?\s*10\s*股?\s*派(?:发)?\s*([0-9]+(?:\.[0-9]+)?)\s*元",
        r"10\s*派\s*([0-9]+(?:\.[0-9]+)?)\s*元",
    ):
        match = re.search(pattern, text)
        if match:
            parsed = _safe_float(match.group(1))
            if parsed is not None and parsed > 0:
                return parsed / 10.0

    match_per_share = re.search(r"每\s*股\s*派(?:发)?\s*([0-9]+(?:\.[0-9]+)?)\s*元", text)
    if match_per_share:
        parsed = _safe_float(match_per_share.group(1))
        if parsed is not None and parsed > 0:
            return parsed
    return None


def _extract_cash_dividend_per_share(row: pd.Series) -> Optional[float]:
    """Extract pre-tax cash dividend per share from a row."""
    plan_text = _safe_str(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["plan_text"]))
    # Keep pre-tax semantics; skip explicit after-tax plans unless pre-tax marker exists.
    if "税后" in plan_text and "税前" not in plan_text and "含税" not in plan_text:
        return None

    direct = _safe_float(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["per_share"]))
    if direct is not None and direct > 0:
        return direct
    return _parse_dividend_plan_to_per_share(plan_text)


def _filter_rows_by_code(df: pd.DataFrame, stock_code: str) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()
    code_cols = [c for c in df.columns if any(k in str(c) for k in ("代码", "股票代码", "证券代码", "symbol", "ts_code"))]
    if not code_cols:
        return df

    target = _normalize_code(stock_code)
    for col in code_cols:
        try:
            series = df[col].astype(str).map(_normalize_code)
            filtered = df[series == target]
            if not filtered.empty:
                return filtered
        except Exception:
            continue
    return pd.DataFrame()


def _normalize_report_date(value: Any) -> Optional[str]:
    parsed = _safe_datetime(value)
    return parsed.date().isoformat() if parsed else None


# akshare stock_financial_abstract 指标行 -> 字段（精确匹配指标名）
_ABSTRACT_METRIC_MAP = {
    "revenue": "营业总收入",
    "net_profit_parent": "归母净利润",
    "operating_cash_flow": "经营现金流量净额",
    "roe": "净资产收益率(ROE)",
    "gross_margin": "毛利率",
    "revenue_yoy": "营业总收入增长率",
    "net_profit_yoy": "归属母公司净利润增长率",
}


def _parse_financial_abstract(df: pd.DataFrame) -> Optional[Dict[str, Any]]:
    """
    解析 akshare ``stock_financial_abstract`` 的「指标做行、报告期做列」宽表。

    该接口列形如 ``选项/指标/20260331/20251231/...``，指标名（营业总收入、归母净利润、
    净资产收益率(ROE) 等）是「指标」列里的值而非列名，因此通用的列名关键字匹配取不到数据。
    这里对指标名做精确匹配，取最新报告期列的值。无法识别格式时返回 ``None`` 以便回退。
    """
    if not isinstance(df, pd.DataFrame) or df.empty or "指标" not in df.columns:
        return None

    date_cols = [c for c in df.columns if str(c).isdigit() and len(str(c)) == 8]
    if not date_cols:
        return None
    latest = max(date_cols, key=lambda c: str(c))

    # 指标名 -> 最新报告期数值（同名指标取首次出现）
    metric_values: Dict[str, Any] = {}
    for _, row in df.iterrows():
        name = str(row.get("指标") or "").strip()
        if name and name not in metric_values:
            metric_values[name] = row.get(latest)

    picked = {
        field: _safe_float(metric_values.get(indicator))
        for field, indicator in _ABSTRACT_METRIC_MAP.items()
    }

    growth = {
        "revenue_yoy": picked["revenue_yoy"],
        "net_profit_yoy": picked["net_profit_yoy"],
        "roe": picked["roe"],
        "gross_margin": picked["gross_margin"],
    }
    financial_report = {
        "report_date": _normalize_report_date(str(latest)),
        "revenue": picked["revenue"],
        "net_profit_parent": picked["net_profit_parent"],
        "operating_cash_flow": picked["operating_cash_flow"],
        "roe": picked["roe"],
    }
    return {"growth": growth, "financial_report": financial_report}


def _build_dividend_payload(
    dividend_df: pd.DataFrame,
    stock_code: str,
    max_events: int = 5,
) -> Dict[str, Any]:
    work_df = _filter_rows_by_code(dividend_df, stock_code)
    if work_df.empty:
        return {}

    now_date = datetime.now().date()
    ttm_start_date = now_date - timedelta(days=365)
    dedupe_keys = set()
    events: List[Dict[str, Any]] = []

    for _, row in work_df.iterrows():
        if not isinstance(row, pd.Series):
            continue
        ex_dt = _safe_datetime(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["ex_dividend_date"]))
        record_dt = _safe_datetime(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["record_date"]))
        announce_dt = _safe_datetime(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["announce_date"]))
        event_dt = ex_dt or record_dt or announce_dt
        if event_dt is None:
            continue
        event_date = event_dt.date()
        if event_date > now_date:
            continue

        per_share = _extract_cash_dividend_per_share(row)
        if per_share is None or per_share <= 0:
            continue

        dedupe_key = (event_date.isoformat(), round(per_share, 6))
        if dedupe_key in dedupe_keys:
            continue
        dedupe_keys.add(dedupe_key)

        events.append(
            {
                "event_date": event_date.isoformat(),
                "ex_dividend_date": ex_dt.date().isoformat() if ex_dt else None,
                "record_date": record_dt.date().isoformat() if record_dt else None,
                "announcement_date": announce_dt.date().isoformat() if announce_dt else None,
                "cash_dividend_per_share": round(per_share, 6),
                "is_pre_tax": True,
            }
        )

    if not events:
        return {}

    events.sort(key=lambda item: item.get("event_date") or "", reverse=True)
    ttm_events: List[Dict[str, Any]] = []
    for item in events:
        event_dt = _safe_datetime(item.get("event_date"))
        if event_dt is None:
            continue
        event_date = event_dt.date()
        if ttm_start_date <= event_date <= now_date:
            ttm_events.append(item)

    return {
        "events": events[:max(1, max_events)],
        "ttm_event_count": len(ttm_events),
        "ttm_cash_dividend_per_share": (
            round(sum(float(item.get("cash_dividend_per_share") or 0.0) for item in ttm_events), 6)
            if ttm_events else None
        ),
        "coverage": "cash_dividend_pre_tax",
        "as_of": now_date.isoformat(),
    }


def _extract_latest_row(df: pd.DataFrame, stock_code: str) -> Optional[pd.Series]:
    """
    Select the most relevant row for the given stock.
    """
    if df is None or df.empty:
        return None

    code_cols = [c for c in df.columns if any(k in str(c) for k in ("代码", "股票代码", "证券代码", "ts_code", "symbol"))]
    target = _normalize_code(stock_code)
    if code_cols:
        for col in code_cols:
            try:
                series = df[col].astype(str).map(_normalize_code)
                matched = df[series == target]
                if not matched.empty:
                    return matched.iloc[0]
            except Exception:
                continue
        return None

    # Fallback: use latest row
    return df.iloc[0]


class AkshareFundamentalAdapter:
    """AkShare adapter for fundamentals, capital flow and dragon-tiger signals."""

    # sina ggtj 接口分页 7~22 次（按 symbol 决定），全量耗时 2.5~13 秒；缓存复用
    # 跨股票分析。30 分钟内龙虎榜窗口结果稳定，足以覆盖一次批量分析任务。
    _SINA_LHB_TTL_SECONDS = 1800
    _SINA_LHB_PREWARM_SYMBOL = "30"
    _sina_lhb_cache: Dict[str, Tuple[float, pd.DataFrame]] = {}
    _sina_lhb_cache_lock = threading.Lock()
    _sina_lhb_prewarm_started = False
    _sina_lhb_prewarm_lock = threading.Lock()

    def prewarm_sina_lhb(self) -> None:
        """进程级单次后台预热 sina 龙虎榜缓存。

        sina ggtj 接口冷启动 ~13 秒，而 fundamental stage budget 默认 8 秒，
        导致首只股票分析时 dragon_tiger 必然 budget 不足。
        在服务起来后立刻预热一次，让首次分析就能命中缓存。

        由调用方（如 DataFetcherManager 初始化）显式触发，避免单测场景下
        意外发起网络请求。
        """
        cls = type(self)
        with cls._sina_lhb_prewarm_lock:
            if cls._sina_lhb_prewarm_started:
                return
            cls._sina_lhb_prewarm_started = True

        def _runner() -> None:
            t0 = time.time()
            logger.info(
                "[FundamentalAdapter] sina LHB 预热开始 (symbol=%s)",
                cls._SINA_LHB_PREWARM_SYMBOL,
            )
            try:
                df = self._get_sina_lhb_df(cls._SINA_LHB_PREWARM_SYMBOL)
            except Exception as exc:  # 预热失败不影响主流程
                logger.warning(
                    "[FundamentalAdapter] sina LHB 预热异常: %s", exc
                )
                return
            elapsed = time.time() - t0
            if df is None:
                logger.warning(
                    "[FundamentalAdapter] sina LHB 预热未拿到数据，耗时 %.1fs", elapsed
                )
            else:
                logger.info(
                    "[FundamentalAdapter] sina LHB 预热完成: %d 行，耗时 %.1fs",
                    len(df), elapsed,
                )

        thread = threading.Thread(
            target=_runner,
            daemon=True,
            name="sina-lhb-prewarm",
        )
        thread.start()

    def _get_sina_lhb_df(self, symbol: str) -> Optional[pd.DataFrame]:
        """读取 / 拉取并缓存 sina 龙虎榜统计 DataFrame。

        即使首次调用因上游 budget 超时被中断，本方法的 worker thread 仍会
        把结果填进类级缓存，下一次分析直接命中。
        """
        cached = self._peek_sina_lhb_df(symbol)
        if cached is not None:
            return cached

        df, _source, _errors = self._call_df_candidates([
            ("stock_lhb_ggtj_sina", {"symbol": symbol}),
        ])
        if df is None:
            return None

        with self._sina_lhb_cache_lock:
            self._sina_lhb_cache[symbol] = (time.time(), df)
        return df

    def _peek_sina_lhb_df(self, symbol: str) -> Optional[pd.DataFrame]:
        """只读缓存：命中且未过期返回 DataFrame；否则返回 None（不发起请求）。"""
        now = time.time()
        with self._sina_lhb_cache_lock:
            entry = self._sina_lhb_cache.get(symbol)
            if entry is None:
                return None
            cached_at, cached_df = entry
            if now - cached_at >= self._SINA_LHB_TTL_SECONDS:
                return None
            return cached_df

    def try_dragon_tiger_from_cache(
        self, stock_code: str, lookback_days: int = 20
    ) -> Optional[Dict[str, Any]]:
        """缓存命中时返回完整 dragon_tiger payload；冷缓存时返回 None。

        让上游 `get_dragon_tiger_context` 在 fundamental stage budget 已耗尽
        的情况下也能秒回缓存结果，避免 sina 路径被预算机制误伤。
        """
        if lookback_days <= 0 or lookback_days > 60:
            return None

        if lookback_days <= 5:
            symbol = "5"
        elif lookback_days <= 10:
            symbol = "10"
        elif lookback_days <= 30:
            symbol = "30"
        else:
            symbol = "60"

        cached_df = self._peek_sina_lhb_df(symbol)
        if cached_df is None:
            return None

        # 已缓存：复用 _dragon_tiger_via_sina 的解析逻辑，但需手工传 df
        # （避免它再次走 _get_sina_lhb_df 的请求兜底）。
        return self._parse_sina_lhb_df(cached_df, stock_code, symbol)

    def _parse_sina_lhb_df(
        self, df: pd.DataFrame, stock_code: str, symbol: str
    ) -> Dict[str, Any]:
        """将 sina ggtj DataFrame 解析为 dragon_tiger payload。"""
        result: Dict[str, Any] = {
            "status": "ok",
            "is_on_list": False,
            "recent_count": 0,
            "latest_date": None,
            "source_chain": [f"dragon_tiger:stock_lhb_ggtj_sina#window_{symbol}d"],
            "errors": [],
        }

        code_cols = [
            c for c in df.columns
            if any(k in str(c) for k in ("代码", "股票代码", "证券代码"))
        ]
        if not code_cols:
            result["status"] = "partial"
            return result

        target = _normalize_code(stock_code)
        matched = pd.DataFrame()
        for col in code_cols:
            try:
                series = df[col].astype(str).map(_normalize_code)
                cur = df[series == target]
                if not cur.empty:
                    matched = cur
                    break
            except Exception:
                continue

        if matched.empty:
            return result

        count_col = next(
            (c for c in matched.columns if any(k in str(c) for k in ("上榜次数", "次数"))),
            None,
        )
        if count_col is not None:
            try:
                count_value = int(matched.iloc[0][count_col])
            except (TypeError, ValueError):
                count_value = 0
            result["recent_count"] = count_value
            result["is_on_list"] = count_value > 0
        else:
            result["recent_count"] = int(len(matched))
            result["is_on_list"] = True

        return result

    def _call_df_candidates(
        self,
        candidates: List[Tuple[str, Dict[str, Any]]],
    ) -> Tuple[Optional[pd.DataFrame], Optional[str], List[str]]:
        errors: List[str] = []
        try:
            import akshare as ak
        except Exception as exc:
            return None, None, [f"import_akshare:{type(exc).__name__}"]

        for func_name, kwargs in candidates:
            fn = getattr(ak, func_name, None)
            if fn is None:
                continue
            try:
                df = fn(**kwargs)
                if isinstance(df, pd.Series):
                    df = df.to_frame().T
                if isinstance(df, pd.DataFrame) and not df.empty:
                    return df, func_name, errors
            except Exception as exc:
                errors.append(f"{func_name}:{type(exc).__name__}")
                continue
        return None, None, errors

    def get_fundamental_bundle(self, stock_code: str) -> Dict[str, Any]:
        """
        Return normalized fundamental blocks from AkShare with partial tolerance.
        """
        result: Dict[str, Any] = {
            "status": "not_supported",
            "growth": {},
            "earnings": {},
            "institution": {},
            "source_chain": [],
            "errors": [],
        }

        # Financial indicators
        fin_df, fin_source, fin_errors = self._call_df_candidates([
            ("stock_financial_abstract", {"symbol": stock_code}),
            ("stock_financial_analysis_indicator", {"symbol": stock_code}),
            ("stock_financial_analysis_indicator", {}),
        ])
        result["errors"].extend(fin_errors)
        if fin_df is not None:
            abstract = _parse_financial_abstract(fin_df)
            if abstract is not None:
                result["growth"] = abstract["growth"]
                fr = abstract["financial_report"]
                if any(v is not None for k, v in fr.items() if k != "report_date"):
                    result["earnings"]["financial_report"] = fr
                result["source_chain"].append(f"growth:{fin_source}")
            else:
                row = _extract_latest_row(fin_df, stock_code)
                if row is not None:
                    revenue_yoy = _safe_float(_pick_by_keywords(row, ["营业收入同比", "营收同比", "收入同比", "同比增长"]))
                    profit_yoy = _safe_float(_pick_by_keywords(row, ["净利润同比", "净利同比", "归母净利润同比"]))
                    roe = _safe_float(_pick_by_keywords(row, ["净资产收益率", "ROE", "净资产收益"]))
                    gross_margin = _safe_float(_pick_by_keywords(row, ["毛利率"]))
                    report_date = _normalize_report_date(_pick_by_keywords(row, _DIVIDEND_KEYWORD_MAP["report_date"]))
                    revenue = _safe_float(_pick_by_keywords(row, ["营业总收入", "营业收入", "营收"]))
                    net_profit_parent = _safe_float(_pick_by_keywords(row, ["归母净利润", "母公司股东净利润", "净利润"]))
                    operating_cash_flow = _safe_float(
                        _pick_by_keywords(row, ["经营活动产生的现金流量净额", "经营现金流", "经营活动现金流"])
                    )
                    result["growth"] = {
                        "revenue_yoy": revenue_yoy,
                        "net_profit_yoy": profit_yoy,
                        "roe": roe,
                        "gross_margin": gross_margin,
                    }
                    financial_report_payload = {
                        "report_date": report_date,
                        "revenue": revenue,
                        "net_profit_parent": net_profit_parent,
                        "operating_cash_flow": operating_cash_flow,
                        "roe": roe,
                    }
                    if any(v is not None for v in financial_report_payload.values()):
                        result["earnings"]["financial_report"] = financial_report_payload
                    result["source_chain"].append(f"growth:{fin_source}")

        # Earnings forecast
        forecast_df, forecast_source, forecast_errors = self._call_df_candidates([
            ("stock_yjyg_em", {"symbol": stock_code}),
            ("stock_yjyg_em", {}),
            ("stock_yjbb_em", {"symbol": stock_code}),
            ("stock_yjbb_em", {}),
        ])
        result["errors"].extend(forecast_errors)
        if forecast_df is not None:
            row = _extract_latest_row(forecast_df, stock_code)
            if row is not None:
                result["earnings"]["forecast_summary"] = _safe_str(
                    _pick_by_keywords(row, ["预告", "业绩变动", "内容", "摘要", "公告"])
                )[:200]
                result["source_chain"].append(f"earnings_forecast:{forecast_source}")

        # Earnings quick report
        quick_df, quick_source, quick_errors = self._call_df_candidates([
            ("stock_yjkb_em", {"symbol": stock_code}),
            ("stock_yjkb_em", {}),
        ])
        result["errors"].extend(quick_errors)
        if quick_df is not None:
            row = _extract_latest_row(quick_df, stock_code)
            if row is not None:
                result["earnings"]["quick_report_summary"] = _safe_str(
                    _pick_by_keywords(row, ["快报", "摘要", "公告", "说明"])
                )[:200]
                result["source_chain"].append(f"earnings_quick:{quick_source}")

        # Dividend details (cash dividend, pre-tax)
        dividend_df, dividend_source, dividend_errors = self._call_df_candidates([
            ("stock_fhps_detail_em", {"symbol": stock_code}),
            ("stock_history_dividend_detail", {"symbol": stock_code, "indicator": "分红", "date": ""}),
            ("stock_dividend_cninfo", {"symbol": stock_code}),
        ])
        result["errors"].extend(dividend_errors)
        if dividend_df is not None:
            dividend_payload = _build_dividend_payload(dividend_df, stock_code, max_events=5)
            if dividend_payload:
                result["earnings"]["dividend"] = dividend_payload
                result["source_chain"].append(f"dividend:{dividend_source}")

        # Institution / top shareholders
        inst_df, inst_source, inst_errors = self._call_df_candidates([
            ("stock_institute_hold", {}),
            ("stock_institute_recommend", {}),
        ])
        result["errors"].extend(inst_errors)
        if inst_df is not None:
            row = _extract_latest_row(inst_df, stock_code)
            if row is not None:
                inst_change = _safe_float(_pick_by_keywords(row, ["增减", "变化", "变动", "持股变化"]))
                result["institution"]["institution_holding_change"] = inst_change
                result["source_chain"].append(f"institution:{inst_source}")

        top10_df, top10_source, top10_errors = self._call_df_candidates([
            ("stock_gdfx_top_10_em", {"symbol": stock_code}),
            ("stock_gdfx_top_10_em", {}),
            ("stock_zh_a_gdhs_detail_em", {"symbol": stock_code}),
            ("stock_zh_a_gdhs_detail_em", {}),
        ])
        result["errors"].extend(top10_errors)
        if top10_df is not None:
            row = _extract_latest_row(top10_df, stock_code)
            if row is not None:
                holder_change = _safe_float(_pick_by_keywords(row, ["增减", "变化", "持股变化", "变动"]))
                result["institution"]["top10_holder_change"] = holder_change
                result["source_chain"].append(f"top10:{top10_source}")

        has_content = bool(result["growth"] or result["earnings"] or result["institution"])
        result["status"] = "partial" if has_content else "not_supported"
        return result

    def get_capital_flow(self, stock_code: str, top_n: int = 5) -> Dict[str, Any]:
        """
        Return stock + sector capital flow.

        个股资金流优先雪球（如配置了 XUEQIU_COOKIE），否则回退到 akshare 各路径
        （多数走 push2.eastmoney 容易被网络阻断）。板块资金流仍走 akshare。
        """
        result: Dict[str, Any] = {
            "status": "not_supported",
            "stock_flow": {},
            "sector_rankings": {"top": [], "bottom": []},
            "source_chain": [],
            "errors": [],
        }

        # 优先：雪球 capital/history 个股资金流
        xq_payload = self._stock_capital_flow_via_xueqiu(stock_code)
        skip_sector = False
        if xq_payload is not None:
            result["stock_flow"] = xq_payload["stock_flow"]
            result["source_chain"].append(f"capital_stock:{xq_payload['source']}")
            # 雪球已拿到 stock_flow；akshare 板块资金流走的 push2 在被阻断的
            # 网络下要 retry 几秒才放弃，会撑爆 fundamental fetch budget。
            # 个股资金流是 AI 主要消费维度，sector_rankings 是 nice-to-have，
            # 这里直接跳过 sector 部分，整块以 stock_flow 返回 partial。
            skip_sector = True
        else:
            stock_df, stock_source, stock_errors = self._call_df_candidates([
                ("stock_individual_fund_flow", {"stock": stock_code}),
                ("stock_individual_fund_flow", {"symbol": stock_code}),
                ("stock_individual_fund_flow", {}),
                ("stock_main_fund_flow", {"symbol": stock_code}),
                ("stock_main_fund_flow", {}),
            ])
            result["errors"].extend(stock_errors)
            if stock_df is not None:
                row = _extract_latest_row(stock_df, stock_code)
                if row is not None:
                    net_inflow = _safe_float(_pick_by_keywords(row, ["主力净流入", "净流入", "净额"]))
                    inflow_5d = _safe_float(_pick_by_keywords(row, ["5日", "五日"]))
                    inflow_10d = _safe_float(_pick_by_keywords(row, ["10日", "十日"]))
                    result["stock_flow"] = {
                        "main_net_inflow": net_inflow,
                        "inflow_5d": inflow_5d,
                        "inflow_10d": inflow_10d,
                    }
                    result["source_chain"].append(f"capital_stock:{stock_source}")

        if skip_sector:
            sector_df, sector_source, sector_errors = None, None, []
        else:
            sector_df, sector_source, sector_errors = self._call_df_candidates([
                ("stock_sector_fund_flow_rank", {}),
                ("stock_sector_fund_flow_summary", {}),
            ])
        result["errors"].extend(sector_errors)
        if sector_df is not None:
            name_col = next((c for c in sector_df.columns if any(k in str(c) for k in ("板块", "行业", "名称", "name"))), None)
            flow_col = next((c for c in sector_df.columns if any(k in str(c) for k in ("净流入", "主力", "flow", "净额"))), None)
            if name_col and flow_col:
                work_df = sector_df[[name_col, flow_col]].copy()
                work_df[flow_col] = pd.to_numeric(work_df[flow_col], errors="coerce")
                work_df = work_df.dropna(subset=[flow_col])
                top_df = work_df.nlargest(top_n, flow_col)
                bottom_df = work_df.nsmallest(top_n, flow_col)
                result["sector_rankings"] = {
                    "top": [{"name": _safe_str(r[name_col]), "net_inflow": float(r[flow_col])} for _, r in top_df.iterrows()],
                    "bottom": [{"name": _safe_str(r[name_col]), "net_inflow": float(r[flow_col])} for _, r in bottom_df.iterrows()],
                }
                result["source_chain"].append(f"capital_sector:{sector_source}")

        has_content = bool(result["stock_flow"] or result["sector_rankings"]["top"] or result["sector_rankings"]["bottom"])
        result["status"] = "partial" if has_content else "not_supported"
        return result

    # ----- 雪球资金流（替代被阻断的 push2.eastmoney 路径）-----

    _XUEQIU_CAPITAL_HISTORY_URL = "https://stock.xueqiu.com/v5/stock/capital/history.json"
    _XUEQIU_REQUEST_TIMEOUT = 5.0
    # cookie 失败冷却：避免 cookie 过期时反复打 401
    _xueqiu_capital_last_fail_ts: float = 0.0
    _XUEQIU_CAPITAL_FAIL_COOLDOWN_SECONDS: float = 300.0

    @staticmethod
    def _to_xueqiu_symbol(stock_code: str) -> Optional[str]:
        """A 股代码加 SH/SZ 前缀。0/3 → SZ；6/8/9 → SH。"""
        code = (stock_code or "").strip()
        if len(code) != 6 or not code.isdigit():
            return None
        if code[:1] in ("6", "8", "9"):
            return f"SH{code}"
        return f"SZ{code}"

    def _stock_capital_flow_via_xueqiu(
        self, stock_code: str
    ) -> Optional[Dict[str, Any]]:
        """从雪球 capital/history 拿主力净额 sum3/sum5/sum10/sum20。

        返回 dict 含 stock_flow 子字段；cookie 未配置 / 失败时返回 None，
        让调用方回退 akshare 候选链。
        """
        cookie = (os.getenv("XUEQIU_COOKIE") or "").strip()
        if not cookie:
            return None

        symbol = self._to_xueqiu_symbol(stock_code)
        if not symbol:
            return None

        # 失败冷却：避免 cookie 过期时反复重试
        now = time.time()
        cls = type(self)
        if now - cls._xueqiu_capital_last_fail_ts < cls._XUEQIU_CAPITAL_FAIL_COOLDOWN_SECONDS:
            return None

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": "https://xueqiu.com/",
            "Cookie": cookie,
        }
        try:
            resp = requests.get(
                self._XUEQIU_CAPITAL_HISTORY_URL,
                params={"symbol": symbol, "count": 5},
                headers=headers,
                timeout=self._XUEQIU_REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json()
        except Exception as exc:
            cls._xueqiu_capital_last_fail_ts = now
            logger.warning("[Xueqiu] capital/history 失败，进入冷却: %s", exc)
            return None

        if body.get("error_code") not in (0, None) and not body.get("data"):
            cls._xueqiu_capital_last_fail_ts = now
            logger.warning(
                "[Xueqiu] capital/history 返回错误 (cookie 可能已过期): "
                "error_code=%s msg=%s",
                body.get("error_code"),
                body.get("error_description") or body.get("msg"),
            )
            return None

        data = body.get("data") or {}
        items = data.get("items") or []
        latest = items[-1] if items else None
        latest_amount = float(latest["amount"]) if isinstance(latest, dict) and "amount" in latest else None

        sum5 = data.get("sum5")
        sum10 = data.get("sum10")
        return {
            "source": "xueqiu_capital_history",
            "stock_flow": {
                "main_net_inflow": latest_amount,
                "inflow_5d": float(sum5) if sum5 is not None else None,
                "inflow_10d": float(sum10) if sum10 is not None else None,
            },
        }

    # ----- 龙虎榜 -----

    def get_dragon_tiger_flag(self, stock_code: str, lookback_days: int = 20) -> Dict[str, Any]:
        """
        Return dragon-tiger signal in lookback window.

        优先尝试 sina 路径 (`stock_lhb_ggtj_sina`)：在东财接口被网络阻断
        的环境下也能拿到上榜次数；该接口仅支持 5/10/30/60 天的预设窗口，
        当 lookback_days <= 30 时映射到 30 天窗口（轻微 overshoot 可接受），
        否则回退到原有东财候选链。
        """
        result: Dict[str, Any] = {
            "status": "not_supported",
            "is_on_list": False,
            "recent_count": 0,
            "latest_date": None,
            "source_chain": [],
            "errors": [],
        }

        # 优先：sina 个股上榜统计（无需 token，网络稳定）
        sina_payload = self._dragon_tiger_via_sina(stock_code, lookback_days)
        if sina_payload is not None:
            return sina_payload

        df, source, errors = self._call_df_candidates([
            ("stock_lhb_stock_statistic_em", {}),
            ("stock_lhb_detail_em", {}),
            ("stock_lhb_jgmmtj_em", {}),
        ])
        result["errors"].extend(errors)
        if df is None:
            return result

        # Try code filter
        code_cols = [c for c in df.columns if any(k in str(c) for k in ("代码", "股票代码", "证券代码"))]
        target = _normalize_code(stock_code)
        matched = pd.DataFrame()
        for col in code_cols:
            try:
                series = df[col].astype(str).map(_normalize_code)
                cur = df[series == target]
                if not cur.empty:
                    matched = cur
                    break
            except Exception:
                continue
        if matched.empty:
            result["source_chain"].append(f"dragon_tiger:{source}")
            result["status"] = "ok" if code_cols else "partial"
            return result

        date_col = next((c for c in matched.columns if any(k in str(c) for k in ("日期", "上榜", "交易日", "time"))), None)
        parsed_dates: List[datetime] = []
        if date_col is not None:
            for val in matched[date_col].astype(str).tolist():
                try:
                    parsed_dates.append(pd.to_datetime(val).to_pydatetime())
                except Exception:
                    continue
        now = datetime.now()
        start = now - timedelta(days=max(1, lookback_days))
        recent_dates = [d for d in parsed_dates if start <= d <= now]

        result["is_on_list"] = bool(recent_dates)
        result["recent_count"] = len(recent_dates) if recent_dates else int(len(matched))
        result["latest_date"] = max(recent_dates).date().isoformat() if recent_dates else (
            max(parsed_dates).date().isoformat() if parsed_dates else None
        )
        result["status"] = "ok"
        result["source_chain"].append(f"dragon_tiger:{source}")
        return result

    def _dragon_tiger_via_sina(
        self, stock_code: str, lookback_days: int
    ) -> Optional[Dict[str, Any]]:
        """通过 akshare sina 接口拿龙虎榜上榜统计。

        sina 接口窗口固定，映射如下：
        - lookback_days <= 5 → "5"
        - 5 < lookback_days <= 10 → "10"
        - 10 < lookback_days <= 30 → "30"
        - 30 < lookback_days <= 60 → "60"
        - lookback_days > 60 时返回 None，调用方回退东财候选链。

        返回完整的 dragon_tiger payload；接口失败 / 缺字段 / 越界时返回 None。

        sina 接口分页较多（30 天窗口约 13 秒），结果在类级缓存复用，避免
        多股票分析时反复全量拉取。
        """
        if lookback_days <= 0 or lookback_days > 60:
            return None

        if lookback_days <= 5:
            symbol = "5"
        elif lookback_days <= 10:
            symbol = "10"
        elif lookback_days <= 30:
            symbol = "30"
        else:
            symbol = "60"

        df = self._get_sina_lhb_df(symbol)
        if df is None:
            return None
        return self._parse_sina_lhb_df(df, stock_code, symbol)
