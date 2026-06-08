# -*- coding: utf-8 -*-
"""
Web UI 专用端点

为 web/ 前端聚合大盘快照、选股推荐等数据。
不引入新业务,纯粹是把已有的 DataFetcherManager / recommendation_service
的结果整理成前端方便消费的扁平 JSON。
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from data_provider import DataFetcherManager

logger = logging.getLogger(__name__)

router = APIRouter()

# 进程内单例,避免每次请求重建数据源
_manager: Optional[DataFetcherManager] = None

# Dashboard 快照缓存:akshare 兜底链路单次 ~50s,行情数据分钟级更新够用,300s 复用(按 region 分桶)
_DASHBOARD_TTL_SECONDS = 300
_dashboard_cache: Dict[str, Tuple[float, "DashboardSnapshot"]] = {}

# 美股 11 个 SPDR sector ETF,代表标准行业板块
_US_SECTOR_ETFS: List[Tuple[str, str]] = [
    ("XLK", "科技"),
    ("XLF", "金融"),
    ("XLV", "医疗保健"),
    ("XLE", "能源"),
    ("XLY", "非必需消费"),
    ("XLP", "必需消费"),
    ("XLI", "工业"),
    ("XLB", "材料"),
    ("XLU", "公用事业"),
    ("XLRE", "房地产"),
    ("XLC", "通信"),
]

# 港股代表性 ETF / 子指数(yfinance 可达)
_HK_SECTOR_ETFS: List[Tuple[str, str]] = [
    ("2800.HK", "盈富 · 恒指"),
    ("2828.HK", "恒生国企"),
    ("3032.HK", "恒生科技"),
    ("3110.HK", "恒生央企"),
    ("3193.HK", "恒生医疗"),
    ("3115.HK", "亚洲 50"),
]

# 后台预热:每 4 分钟在后台跑一遍 dashboard,把缓存焐热,用户访问永远命中。
_WARMUP_INTERVAL_SECONDS = 240
_warmup_thread: Optional[threading.Thread] = None
_warmup_lock = threading.Lock()

# Recommend 异步任务表(进程内内存):start 返回 task_id,前端用 status 轮询
_recommend_tasks: Dict[str, Dict[str, Any]] = {}
_recommend_tasks_lock = threading.Lock()
_RECOMMEND_TASK_TTL_SECONDS = 1800  # 30 分钟后清理

# Briefing(早盘 / 收盘)异步任务表
_briefing_tasks: Dict[str, Dict[str, Any]] = {}
_briefing_tasks_lock = threading.Lock()


def _get_manager() -> DataFetcherManager:
    global _manager
    if _manager is None:
        _manager = DataFetcherManager()
    return _manager


class IndexQuoteOut(BaseModel):
    code: str
    name: str
    current: Optional[float] = None
    change_pct: Optional[float] = None
    change: Optional[float] = None


class MarketStatsOut(BaseModel):
    up: Optional[int] = None
    down: Optional[int] = None
    limit_up: Optional[int] = None
    limit_down: Optional[int] = None
    unchanged: Optional[int] = None
    total_amount: Optional[float] = None  # 总成交额(亿元,后端按需返回)


class SectorEntryOut(BaseModel):
    name: str
    change_pct: Optional[float] = None


class DashboardSnapshot(BaseModel):
    region: str
    generated_at: str
    indices: List[IndexQuoteOut]
    market_stats: Optional[MarketStatsOut] = None
    top_sectors: List[SectorEntryOut]
    bottom_sectors: List[SectorEntryOut]


_VALID_REGIONS = {"cn", "hk", "us"}


@router.get("/dashboard", response_model=DashboardSnapshot)
def get_dashboard(
    region: str = Query("cn", pattern="^(cn|hk|us)$", description="市场:cn / hk / us"),
    refresh: bool = Query(False, description="强制刷新,跳过缓存"),
) -> DashboardSnapshot:
    """聚合大盘快照。A 股含市场统计与板块排行;港美股展示主要指数 + 代表 ETF。300s 内存缓存,按 region 分桶。"""
    if region not in _VALID_REGIONS:
        region = "cn"
    _ensure_warmup_started()
    if not refresh:
        cached = _dashboard_cache.get(region)
        if cached:
            ts, snap = cached
            if time.time() - ts < _DASHBOARD_TTL_SECONDS:
                return snap
    return _compute_dashboard(region)


def _compute_dashboard(region: str) -> DashboardSnapshot:
    """实际抓取 + 装配 dashboard 快照。三个数据源并行调用,写入缓存后返回。"""
    manager = _get_manager()

    # 三个数据源并行(都是 I/O 等待,Python GIL 在 I/O 时释放)
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_indices = ex.submit(manager.get_main_indices, region=region)

        if region == "cn":
            f_stats = ex.submit(manager.get_market_stats)
            f_sectors = ex.submit(manager.get_sector_rankings, 5)
        else:
            f_stats = None
            etfs = _US_SECTOR_ETFS if region == "us" else _HK_SECTOR_ETFS
            f_sectors = ex.submit(_fetch_offshore_sector_change, etfs)

        # 指数
        indices: List[IndexQuoteOut] = []
        try:
            raw = f_indices.result() or []
            # A 股主要指数有 6 个（上证/深证/创业板/科创50/上证50/沪深300），
            # 港美各自 3-4 个。展示上限提到 8 以兼容 cn 全集。
            for idx in raw[:8]:
                indices.append(
                    IndexQuoteOut(
                        code=str(idx.get("code") or ""),
                        name=str(idx.get("name") or ""),
                        current=_safe_float(idx.get("current")),
                        change_pct=_safe_float(idx.get("change_pct")),
                        change=_safe_float(idx.get("change")),
                    )
                )
        except Exception as e:
            logger.warning(f"[Web Dashboard/{region}] 取指数失败: {e}")

        # 市场统计(仅 A 股)
        stats: Optional[MarketStatsOut] = None
        if f_stats is not None:
            try:
                raw_stats = f_stats.result() or {}
                stats = MarketStatsOut(
                    up=_safe_int(raw_stats.get("up_count") or raw_stats.get("up") or raw_stats.get("上涨")),
                    down=_safe_int(raw_stats.get("down_count") or raw_stats.get("down") or raw_stats.get("下跌")),
                    limit_up=_safe_int(raw_stats.get("limit_up_count") or raw_stats.get("limit_up") or raw_stats.get("涨停")),
                    limit_down=_safe_int(raw_stats.get("limit_down_count") or raw_stats.get("limit_down") or raw_stats.get("跌停")),
                    unchanged=_safe_int(raw_stats.get("flat_count") or raw_stats.get("unchanged") or raw_stats.get("平盘")),
                    total_amount=_safe_float(raw_stats.get("total_amount") or raw_stats.get("成交额")),
                )
            except Exception as e:
                logger.warning(f"[Web Dashboard/cn] 取市场统计失败: {e}")

        # 板块
        top: List[SectorEntryOut] = []
        bottom: List[SectorEntryOut] = []
        try:
            if region == "cn":
                t, b = f_sectors.result()
                top = [SectorEntryOut(name=str(s.get("name") or ""), change_pct=_safe_float(s.get("change_pct"))) for s in (t or []) if s.get("name")]
                bottom = [SectorEntryOut(name=str(s.get("name") or ""), change_pct=_safe_float(s.get("change_pct"))) for s in (b or []) if s.get("name")]
            else:
                top, bottom = f_sectors.result()
        except Exception as e:
            logger.warning(f"[Web Dashboard/{region}] 取板块失败: {e}")

    snap = DashboardSnapshot(
        region=region,
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        indices=indices,
        market_stats=stats,
        top_sectors=top,
        bottom_sectors=bottom,
    )
    _dashboard_cache[region] = (time.time(), snap)
    return snap


class RecommendCandidateOut(BaseModel):
    code: str
    name: str
    industry: Optional[str] = None
    last_price: float
    change_pct: float
    score: int
    signals: List[str]
    sector_match: Optional[str] = None


class RecommendOut(BaseModel):
    hot_sectors: List[str]
    candidates: List[RecommendCandidateOut]
    pool_size: Optional[int] = None
    report_path: Optional[str] = None
    query_id: Optional[str] = None
    price_as_of: Optional[str] = None


@router.get("/recommend", response_model=RecommendOut)
def get_recommendation(
    top: int = Query(10, ge=1, le=50, description="输出 Top N"),
    pool: str = Query("hs300", pattern="^(hs300|watchlist|both|sp500)$", description="候选池"),
) -> RecommendOut:
    """同步推荐(保留,适合 CLI / 脚本调用;HS300 池约 3-5 分钟)。前端推荐用 /recommend/start 异步版本。"""
    from src.services.recommendation_service import recommend
    from src.config import get_config

    cfg = get_config()
    watchlist = list(getattr(cfg, "stock_list", None) or [])
    result: Dict[str, Any] = recommend(top_n=top, pool=pool, watchlist=watchlist)

    return RecommendOut(
        hot_sectors=list(result.get("hot_sectors") or []),
        candidates=[
            RecommendCandidateOut(**c) for c in (result.get("candidates") or [])
        ],
        pool_size=result.get("pool_size"),
        report_path=result.get("report_path"),
        query_id=result.get("query_id"),
        price_as_of=result.get("price_as_of"),
    )


class RecommendStartOut(BaseModel):
    task_id: str


class RecommendStatusOut(BaseModel):
    task_id: str
    status: str  # pending / running / completed / failed
    stage: Optional[str] = None  # sectors / pool / score / report
    progress: float = 0.0  # 0-1
    message: Optional[str] = None
    elapsed_seconds: Optional[float] = None
    error: Optional[str] = None
    result: Optional[RecommendOut] = None


@router.post("/recommend/start", response_model=RecommendStartOut)
def start_recommendation(
    top: int = Query(10, ge=1, le=50),
    pool: str = Query("hs300", pattern="^(hs300|watchlist|both|sp500)$"),
) -> RecommendStartOut:
    """异步触发推荐;返回 task_id,前端通过 /recommend/status/{task_id} 轮询。"""
    _gc_recommend_tasks()
    task_id = uuid.uuid4().hex[:12]
    now = time.time()
    with _recommend_tasks_lock:
        _recommend_tasks[task_id] = {
            "status": "pending",
            "stage": None,
            "progress": 0.0,
            "message": "排队中",
            "started_at": now,
            "ended_at": None,
            "error": None,
            "result": None,
        }
    thread = threading.Thread(
        target=_run_recommend_task,
        args=(task_id, top, pool),
        daemon=True,
        name=f"recommend-{task_id}",
    )
    thread.start()
    return RecommendStartOut(task_id=task_id)


@router.get("/recommend/status/{task_id}", response_model=RecommendStatusOut)
def get_recommendation_status(task_id: str) -> RecommendStatusOut:
    with _recommend_tasks_lock:
        task = _recommend_tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"task {task_id} not found")
    started = task.get("started_at") or time.time()
    ended = task.get("ended_at")
    elapsed = (ended or time.time()) - started
    result_out = None
    if task.get("result"):
        r = task["result"]
        result_out = RecommendOut(
            hot_sectors=list(r.get("hot_sectors") or []),
            candidates=[RecommendCandidateOut(**c) for c in (r.get("candidates") or [])],
            pool_size=r.get("pool_size"),
            report_path=r.get("report_path"),
            query_id=r.get("query_id"),
            price_as_of=r.get("price_as_of"),
        )
    return RecommendStatusOut(
        task_id=task_id,
        status=task.get("status", "unknown"),
        stage=task.get("stage"),
        progress=task.get("progress", 0.0),
        message=task.get("message"),
        elapsed_seconds=round(elapsed, 1),
        error=task.get("error"),
        result=result_out,
    )


def _run_recommend_task(task_id: str, top: int, pool: str) -> None:
    from src.services.recommendation_service import recommend
    from src.config import get_config

    def _update(**kwargs: Any) -> None:
        with _recommend_tasks_lock:
            task = _recommend_tasks.get(task_id)
            if task is None:
                return
            task.update(kwargs)

    def _progress_cb(stage: str, current: int, total: int, message: str) -> None:
        # 各阶段权重:sectors 0-5%, pool 5-10%, score 10-95%, report 95-100%
        if stage == "sectors":
            progress = 0.03
        elif stage == "pool":
            progress = 0.08
        elif stage == "score":
            if total <= 0:
                progress = 0.5
            else:
                progress = 0.10 + 0.85 * (current / total)
        elif stage == "report":
            progress = 0.97
        else:
            progress = 0.0
        _update(stage=stage, progress=progress, message=message, status="running")

    _update(status="running", message="开始评分")

    try:
        cfg = get_config()
        watchlist = list(getattr(cfg, "stock_list", None) or [])
        result = recommend(top_n=top, pool=pool, watchlist=watchlist, progress_cb=_progress_cb)
        _update(
            status="completed",
            stage="done",
            progress=1.0,
            message=f"完成,共 {len(result.get('candidates') or [])} 只候选",
            ended_at=time.time(),
            result=result,
        )
    except Exception as e:
        logger.exception(f"[Recommend Task] {task_id} 失败")
        _update(status="failed", error=str(e), ended_at=time.time(), message="任务失败")


def _gc_recommend_tasks() -> None:
    """清理超过 TTL 的已结束任务。"""
    now = time.time()
    with _recommend_tasks_lock:
        for tid in list(_recommend_tasks.keys()):
            task = _recommend_tasks[tid]
            ended = task.get("ended_at")
            if ended is not None and now - ended > _RECOMMEND_TASK_TTL_SECONDS:
                _recommend_tasks.pop(tid, None)


# ---------------------------------------------------------------------------
# Briefing (早盘 / 收盘)
# ---------------------------------------------------------------------------


class BriefingStartOut(BaseModel):
    task_id: str


class BriefingStatusOut(BaseModel):
    task_id: str
    kind: str  # morning / closing
    status: str  # pending / running / completed / failed
    message: Optional[str] = None
    elapsed_seconds: Optional[float] = None
    error: Optional[str] = None
    query_id: Optional[str] = None
    date: Optional[str] = None


@router.post("/briefing/morning/start", response_model=BriefingStartOut)
def start_morning_briefing() -> BriefingStartOut:
    """异步触发早盘播报。"""
    return _briefing_start("morning")


@router.post("/briefing/closing/start", response_model=BriefingStartOut)
def start_closing_summary() -> BriefingStartOut:
    """异步触发收盘总结。"""
    return _briefing_start("closing")


@router.get("/briefing/status/{task_id}", response_model=BriefingStatusOut)
def get_briefing_status(task_id: str) -> BriefingStatusOut:
    with _briefing_tasks_lock:
        task = _briefing_tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"task {task_id} not found")
    started = task.get("started_at") or time.time()
    ended = task.get("ended_at")
    elapsed = (ended or time.time()) - started
    return BriefingStatusOut(
        task_id=task_id,
        kind=task.get("kind", "?"),
        status=task.get("status", "unknown"),
        message=task.get("message"),
        elapsed_seconds=round(elapsed, 1),
        error=task.get("error"),
        query_id=task.get("query_id"),
        date=task.get("date"),
    )


def _briefing_start(kind: str) -> BriefingStartOut:
    task_id = uuid.uuid4().hex[:12]
    now = time.time()
    with _briefing_tasks_lock:
        _briefing_tasks[task_id] = {
            "kind": kind,
            "status": "pending",
            "message": "排队中",
            "started_at": now,
            "ended_at": None,
            "error": None,
            "query_id": None,
            "date": None,
        }
    threading.Thread(
        target=_run_briefing_task,
        args=(task_id, kind),
        daemon=True,
        name=f"briefing-{kind}-{task_id}",
    ).start()
    return BriefingStartOut(task_id=task_id)


def _run_briefing_task(task_id: str, kind: str) -> None:
    from src.services.briefing_service import (
        ClosingSummaryService,
        MorningBriefingService,
    )

    def _update(**kwargs: Any) -> None:
        with _briefing_tasks_lock:
            t = _briefing_tasks.get(task_id)
            if t is None:
                return
            t.update(kwargs)

    _update(status="running", message="生成中…")
    try:
        if kind == "morning":
            result = MorningBriefingService().generate(send_notification=False)
        elif kind == "closing":
            result = ClosingSummaryService().generate(send_notification=False)
        else:
            raise ValueError(f"unsupported briefing kind: {kind}")
        _update(
            status="completed",
            message=f"完成,query_id={result.get('query_id')}",
            ended_at=time.time(),
            query_id=result.get("query_id"),
            date=result.get("date"),
        )
    except Exception as e:
        logger.exception(f"[Briefing] {kind} task {task_id} failed")
        _update(status="failed", error=str(e), ended_at=time.time(), message="任务失败")


def _ensure_warmup_started() -> None:
    """懒启动后台预热线程,只启一次。daemon=True,主进程退出会自动收。"""
    global _warmup_thread
    if _warmup_thread is not None and _warmup_thread.is_alive():
        return
    with _warmup_lock:
        if _warmup_thread is not None and _warmup_thread.is_alive():
            return
        _warmup_thread = threading.Thread(
            target=_warmup_loop, daemon=True, name="dashboard-warmup",
        )
        _warmup_thread.start()
        logger.info(
            f"[Web Dashboard] 后台预热线程已启动,周期 {_WARMUP_INTERVAL_SECONDS}s"
        )


def _warmup_loop() -> None:
    """后台周期跑 dashboard,焐热缓存。三个 region 并行,任何错误吞掉避免线程死掉。"""
    # 第一轮稍等一下让进程完全启动(uvicorn / lifespan / DB init)
    time.sleep(2)

    def _warm_one(region: str) -> None:
        t0 = time.time()
        try:
            _compute_dashboard(region)
            logger.info(
                f"[Web Dashboard warmup] {region} 预热完成,耗时 {time.time()-t0:.1f}s"
            )
        except Exception as e:
            logger.warning(f"[Web Dashboard warmup] {region} 失败: {e}")

    while True:
        # 三个 region 并行预热,总耗时 = max(各 region) 而非 sum
        with ThreadPoolExecutor(max_workers=3) as ex:
            futures = [ex.submit(_warm_one, r) for r in ("cn", "hk", "us")]
            for f in futures:
                f.result()  # 等所有完成
        time.sleep(_WARMUP_INTERVAL_SECONDS)


def _fetch_offshore_sector_change(
    etfs: List[Tuple[str, str]],
) -> Tuple[List[SectorEntryOut], List[SectorEntryOut]]:
    """
    批量拉一组港美股 ETF / 子指数的当日涨跌幅,排序后返回 (top, bottom)。

    用 yfinance batch download,2 日 K 自取最近 2 个有效收盘价,计算 pct_chg。
    """
    import yfinance as yf

    symbols = [s for s, _ in etfs]
    name_map = dict(etfs)
    df = yf.download(
        symbols,
        period="5d",
        progress=False,
        auto_adjust=True,
        group_by="ticker",
    )

    entries: List[SectorEntryOut] = []
    for sym in symbols:
        try:
            sub = df[sym] if hasattr(df.columns, "get_level_values") and sym in df.columns.get_level_values(0) else None
            if sub is None:
                continue
            closes = sub["Close"].dropna()
            if len(closes) < 2:
                continue
            prev = float(closes.iloc[-2])
            curr = float(closes.iloc[-1])
            if prev <= 0:
                continue
            chg = (curr - prev) / prev * 100
            entries.append(SectorEntryOut(name=name_map.get(sym, sym), change_pct=round(chg, 2)))
        except Exception as e:
            logger.debug(f"[offshore-sector] {sym} skip: {e}")
            continue

    if not entries:
        return [], []

    entries.sort(key=lambda x: x.change_pct or 0, reverse=True)
    top = entries[:5]
    bottom = list(reversed(entries[-5:]))
    return top, bottom


def _safe_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
        return f if f == f else None  # 过滤 NaN
    except (TypeError, ValueError):
        return None


def _safe_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None
