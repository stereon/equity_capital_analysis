# -*- coding: utf-8 -*-
"""
美股选股 universe 数据源。

目前只覆盖 S&P 500 成分:从 Wikipedia 拉公开成分表(含 GICS sector),
本地 JSON 文件缓存一周;Wikipedia 不可达时回退过期缓存。

只在 RecommendationService 美股推荐路径下使用,日 K / 实时行情仍走
已有的 YfinanceFetcher,本模块不引入新的行情依赖。
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_SP500_WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
_CACHE_PATH = Path("data/sp500_universe_cache.json")
_CACHE_TTL_SECONDS = 7 * 24 * 3600  # 成分变动很慢,一周一刷足够

# 进程内 mem 缓存,避免每次 recommend 都读盘
_MEM: Dict[str, Any] = {"ts": 0.0, "items": []}


def _normalize_ticker(symbol: str) -> str:
    """Wikipedia 列出的代码偶有 BRK.B / BF.B 这种点号形式,yfinance 用 '-' 连接。"""
    return (symbol or "").strip().upper().replace(".", "-")


def _read_cache(ignore_ttl: bool = False) -> Optional[List[Dict[str, str]]]:
    now = time.time()
    if _MEM["items"] and (ignore_ttl or now - _MEM["ts"] < _CACHE_TTL_SECONDS):
        return list(_MEM["items"])
    try:
        if _CACHE_PATH.exists():
            data = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
            ts = float(data.get("ts", 0))
            items = data.get("items") or []
            if items and (ignore_ttl or now - ts < _CACHE_TTL_SECONDS):
                _MEM.update(ts=ts, items=items)
                return list(items)
    except Exception as e:
        logger.debug(f"[us_universe] 读 cache 失败: {e}")
    return None


def _write_cache(items: List[Dict[str, str]]) -> None:
    _MEM.update(ts=time.time(), items=items)
    try:
        _CACHE_PATH.parent.mkdir(exist_ok=True)
        _CACHE_PATH.write_text(
            json.dumps({"ts": _MEM["ts"], "items": items}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as e:
        logger.debug(f"[us_universe] 写 cache 失败: {e}")


def _fetch_sp500_from_wikipedia() -> List[Dict[str, str]]:
    """pandas.read_html 解析 Wikipedia 成分表。失败抛异常,由调用方决定降级。

    通过 requests 取 HTML(certifi 处理 SSL + 显式 UA 避免被 Wikipedia 拦截),
    再交给 pandas 解析,比 pandas.read_html 直接拉 URL 更稳。
    """
    import io
    import pandas as pd
    import requests

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (compatible; equity-capital-analysis/1.0; "
            "+https://github.com/stereon/equity_capital_analysis)"
        ),
        "Accept": "text/html,application/xhtml+xml",
    }
    resp = requests.get(_SP500_WIKI_URL, headers=headers, timeout=20)
    resp.raise_for_status()

    tables = pd.read_html(io.StringIO(resp.text))
    if not tables:
        raise RuntimeError("Wikipedia returned no tables")
    df = tables[0]
    # 列名形如 'Symbol','Security','GICS Sector','GICS Sub-Industry'
    cols = {str(c).strip().lower(): c for c in df.columns}
    sym_col = cols.get("symbol")
    name_col = cols.get("security") or cols.get("company")
    sector_col = cols.get("gics sector") or cols.get("sector")
    if not sym_col or not name_col:
        raise RuntimeError(f"unexpected SP500 table columns: {list(df.columns)}")

    items: List[Dict[str, str]] = []
    for _, row in df.iterrows():
        ticker = _normalize_ticker(str(row[sym_col]))
        if not ticker:
            continue
        items.append({
            "ticker": ticker,
            "name": str(row[name_col]).strip(),
            "sector": str(row[sector_col]).strip() if sector_col else "",
        })
    return items


def get_sp500_constituents(force_refresh: bool = False) -> List[Dict[str, str]]:
    """返回 [{ticker, name, sector}, ...]。

    优先级:mem cache → 磁盘 cache(未过期) → Wikipedia → 过期磁盘 cache 兜底 → []。
    """
    if not force_refresh:
        cached = _read_cache()
        if cached is not None:
            return cached
    try:
        items = _fetch_sp500_from_wikipedia()
        if items:
            _write_cache(items)
            logger.info(f"[us_universe] SP500 成分已刷新: {len(items)} 只")
            return items
    except Exception as e:
        logger.warning(f"[us_universe] Wikipedia 拉取失败: {e},尝试回退过期缓存")

    stale = _read_cache(ignore_ttl=True)
    if stale is not None:
        logger.info("[us_universe] SP500 复用过期缓存兜底")
        return stale
    logger.warning("[us_universe] SP500 成分不可用,返回空列表")
    return []


def get_sp500_tickers() -> List[str]:
    return [it["ticker"] for it in get_sp500_constituents() if it.get("ticker")]


def get_sp500_sector_map() -> Dict[str, str]:
    return {it["ticker"]: it.get("sector", "") for it in get_sp500_constituents() if it.get("ticker")}


def get_sp500_name_map() -> Dict[str, str]:
    return {it["ticker"]: it.get("name", "") for it in get_sp500_constituents() if it.get("ticker")}
