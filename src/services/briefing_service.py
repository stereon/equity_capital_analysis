# -*- coding: utf-8 -*-
"""
早盘播报 / 收盘总结编排服务。

复用现有 build_market_review_runtime(GeminiAnalyzer / SearchService / NotificationService),
拉数据 → LLM 生成自然语言总结 → 渲染 Markdown → 写入 analysis_history → 可选推送。

入口:
- `MorningBriefingService().generate(send_notification=False)`  早盘(每天 9:00)
- `ClosingSummaryService().generate(send_notification=False)`   收盘(每天 16:30,港股收盘后)

两份报告都以 AnalysisHistory 记录形式持久化,report_type 分别为
`morning_briefing` / `closing_summary`。
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from src.config import Config, get_config
from src.core.market_review_runtime import build_market_review_runtime, has_configured_llm_runtime

logger = logging.getLogger(__name__)

MORNING_BRIEFING_TYPE = "morning_briefing"
CLOSING_SUMMARY_TYPE = "closing_summary"
MORNING_HISTORY_CODE = "MORNING_BRIEFING"
CLOSING_HISTORY_CODE = "CLOSING_SUMMARY"


# ---------------------------------------------------------------------------
# 共用数据采集 helper
# ---------------------------------------------------------------------------

def _safe_fetch_dashboard(region: str) -> Optional[Dict[str, Any]]:
    """复用 web 端点的 _compute_dashboard 拿到指数 + 市场统计 + 板块。"""
    try:
        from api.v1.endpoints.web import _compute_dashboard
        snap = _compute_dashboard(region)
        return snap.model_dump() if hasattr(snap, "model_dump") else dict(snap)
    except Exception as e:
        logger.warning(f"[Briefing] dashboard({region}) 获取失败: {e}")
        return None


def _safe_fetch_watchlist_news(search_service: Any, query: str, max_results: int = 5) -> List[Dict[str, Any]]:
    """尝试拉一段新闻。最佳努力,失败返回空列表。"""
    try:
        if hasattr(search_service, "search_stock_news"):
            res = search_service.search_stock_news(
                stock_code="market",
                stock_name=query,
                max_results=max_results,
            )
            # SearchResponse 形态:可能是对象,或 dict,或 list
            items: List[Any] = []
            if isinstance(res, list):
                items = res
            elif isinstance(res, dict):
                items = list(res.get("results") or res.get("items") or [])
            elif hasattr(res, "results"):
                items = list(getattr(res, "results", []) or [])
            elif hasattr(res, "items"):
                items = list(getattr(res, "items", []) or [])
            # 归一化每条到 dict
            normalized: List[Dict[str, Any]] = []
            for it in items[:max_results]:
                if isinstance(it, dict):
                    normalized.append(it)
                else:
                    normalized.append({
                        "title": getattr(it, "title", None),
                        "url": getattr(it, "url", None) or getattr(it, "link", None),
                        "published_at": getattr(it, "published_at", None) or getattr(it, "publish_time", None),
                    })
            return normalized
        return []
    except Exception as e:
        logger.warning(f"[Briefing] 新闻搜索失败: {e}")
        return []


def _format_index_lines(indices: List[Dict[str, Any]]) -> List[str]:
    lines: List[str] = []
    for idx in indices or []:
        name = idx.get("name") or idx.get("code") or "?"
        cur = idx.get("current")
        chg = idx.get("change_pct")
        cur_s = f"{cur:.2f}" if isinstance(cur, (int, float)) else "—"
        if isinstance(chg, (int, float)):
            arrow = "🟢" if chg >= 0 else "🔴"
            chg_s = f"{arrow} {chg:+.2f}%"
        else:
            chg_s = "—"
        lines.append(f"- **{name}**: {cur_s} ({chg_s})")
    return lines


def _format_sector_lines(sectors: List[Dict[str, Any]]) -> List[str]:
    lines: List[str] = []
    for s in sectors or []:
        name = s.get("name") or "?"
        chg = s.get("change_pct")
        if isinstance(chg, (int, float)):
            arrow = "🟢" if chg >= 0 else "🔴"
            lines.append(f"- {name}: {arrow} {chg:+.2f}%")
        else:
            lines.append(f"- {name}: —")
    return lines


def _format_news_lines(news: List[Dict[str, Any]], limit: int = 5) -> List[str]:
    lines: List[str] = []
    for item in news[:limit]:
        title = (item.get("title") or item.get("name") or "").strip()
        url = item.get("url") or item.get("link") or ""
        date = item.get("published_at") or item.get("publish_time") or ""
        if not title:
            continue
        prefix = f"`{date}` " if date else ""
        if url:
            lines.append(f"- {prefix}[{title}]({url})")
        else:
            lines.append(f"- {prefix}{title}")
    return lines


def _persist(
    *,
    config: Config,
    report_type: str,
    code: str,
    name: str,
    summary: str,
    markdown: str,
    extra_context: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[int], Optional[str]]:
    """以 AnalysisResult 形态写入 analysis_history;返回 (saved_count, query_id)。"""
    try:
        from src.analyzer import AnalysisResult
        from src.storage import DatabaseManager

        result = AnalysisResult(
            code=code,
            name=name,
            sentiment_score=50,
            trend_prediction=name,
            operation_advice="查看报告",
            analysis_summary=summary[:500] if summary else name,
            report_language=getattr(config, "report_language", "zh"),
            news_summary=summary or "",
            raw_response=markdown,
            data_sources=report_type,
        )

        query_id = f"{report_type}_{uuid.uuid4().hex}"
        context: Dict[str, Any] = {
            "report_kind": report_type,
            "report_language": getattr(config, "report_language", "zh"),
        }
        if extra_context:
            context.update(extra_context)

        saved = DatabaseManager.get_instance().save_analysis_history(
            result=result,
            query_id=query_id,
            report_type=report_type,
            news_content=summary or markdown[:2000],
            context_snapshot=context,
            save_snapshot=True,
        )
        logger.info(f"[Briefing] {report_type} 已写入 history: saved={saved} query_id={query_id}")
        return saved, query_id
    except Exception as e:
        logger.warning(f"[Briefing] 写入 history 失败: {e}", exc_info=True)
        return None, None


def _maybe_push(notification_service: Any, *, title: str, markdown: str) -> None:
    """如果配置了任意通知渠道,推送 markdown 内容。失败吞掉。"""
    if notification_service is None:
        return
    try:
        # NotificationService 各项目实现差异较大,这里尝试常见入口,失败不影响主流程
        candidates = [
            ("send_report", {"title": title, "content": markdown}),
            ("send_message", {"content": markdown}),
            ("push", {"text": markdown}),
        ]
        for method_name, kwargs in candidates:
            method = getattr(notification_service, method_name, None)
            if callable(method):
                method(**kwargs)
                logger.info(f"[Briefing] 通过 {method_name} 推送完成")
                return
    except Exception as e:
        logger.warning(f"[Briefing] 推送失败: {e}")


# ---------------------------------------------------------------------------
# 早盘播报
# ---------------------------------------------------------------------------

MORNING_PROMPT_TEMPLATE = """
你是一位 A 股早盘策略助理。根据下方"隔夜美股 + 港股早盘 + 新闻"数据,
为今天的 A 股早盘提供一份**简洁、可操作**的策略提示。

要求:
1. 用 3-5 个 bullet 总结隔夜美股的关键信号(哪些板块走强/走弱,有无避险情绪)。
2. 用 2-3 个 bullet 总结港股早盘风向(国企/科技/恒指走势暗示什么)。
3. 用 2-3 个 bullet 提炼隔夜重要新闻的 A 股映射(政策/海外财报/地缘)。
4. 给出今日 A 股**可能高开/承压的 2-3 个方向**,每条一行,标注理由。
5. 整体不超过 300 字,语言中性、避免空话。

== 数据 ==

【隔夜美股指数】
{us_indices}

【美股板块(SPDR 11)】
{us_sectors}

【港股早盘】
{hk_indices}

【隔夜重要新闻】
{news}
""".strip()


class MorningBriefingService:
    """早盘播报:汇总隔夜美股 + 港股早盘 + 隔夜新闻 + LLM 生成策略提示。"""

    def __init__(self, config: Optional[Config] = None) -> None:
        self.config = config or get_config()

    def generate(self, send_notification: bool = False) -> Dict[str, Any]:
        logger.info("[Morning Briefing] 开始生成早盘播报...")
        today = datetime.now().strftime("%Y-%m-%d")

        if not has_configured_llm_runtime(self.config):
            logger.warning("[Morning Briefing] 未配置 LLM,跳过 LLM 总结,只渲染原始数据")

        notification_service, analyzer, search_service = build_market_review_runtime(
            self.config, source_message="morning_briefing"
        )

        # 1. 数据采集
        us_snap = _safe_fetch_dashboard("us")
        hk_snap = _safe_fetch_dashboard("hk")

        # 2. 新闻
        news = _safe_fetch_watchlist_news(search_service, "美股 隔夜 财报 政策 联储")
        news_lines = _format_news_lines(news)
        news_text = "\n".join(news_lines) if news_lines else "(暂无最新新闻)"

        # 3. LLM 总结
        llm_summary = ""
        try:
            prompt = MORNING_PROMPT_TEMPLATE.format(
                us_indices="\n".join(_format_index_lines((us_snap or {}).get("indices") or [])) or "(数据缺失)",
                us_sectors="\n".join(_format_sector_lines((us_snap or {}).get("top_sectors", []) + (us_snap or {}).get("bottom_sectors", []))) or "(数据缺失)",
                hk_indices="\n".join(_format_index_lines((hk_snap or {}).get("indices") or [])) or "(数据缺失)",
                news=news_text,
            )
            if analyzer is not None and hasattr(analyzer, "generate_text"):
                llm_summary = analyzer.generate_text(prompt) or ""
        except Exception as e:
            logger.warning(f"[Morning Briefing] LLM 总结失败: {e}")

        # 4. 渲染 Markdown
        markdown = _render_morning_markdown(today, us_snap, hk_snap, news_lines, llm_summary)

        # 5. 持久化
        saved, query_id = _persist(
            config=self.config,
            report_type=MORNING_BRIEFING_TYPE,
            code=MORNING_HISTORY_CODE,
            name="早盘播报",
            summary=(llm_summary or "")[:500] or "隔夜美股 + 港股早盘 + 新闻",
            markdown=markdown,
            extra_context={"date": today},
        )

        # 6. 可选推送
        if send_notification:
            _maybe_push(notification_service, title=f"早盘播报 {today}", markdown=markdown)

        return {
            "query_id": query_id,
            "saved": saved,
            "report_type": MORNING_BRIEFING_TYPE,
            "date": today,
            "markdown": markdown,
            "llm_summary": llm_summary,
        }


def _render_morning_markdown(
    date: str,
    us: Optional[Dict[str, Any]],
    hk: Optional[Dict[str, Any]],
    news_lines: List[str],
    llm_summary: str,
) -> str:
    lines: List[str] = [f"# 🌅 早盘播报 {date}", ""]
    if llm_summary.strip():
        lines += ["## 💡 今日策略提示(LLM)", "", llm_summary.strip(), ""]
    lines += ["## 🌎 隔夜美股", ""]
    if us and us.get("indices"):
        lines += _format_index_lines(us["indices"]) + [""]
    else:
        lines += ["(美股数据获取失败)", ""]
    if us and us.get("top_sectors"):
        lines += ["### SPDR 板块涨幅前 5", ""] + _format_sector_lines(us["top_sectors"]) + [""]
    if us and us.get("bottom_sectors"):
        lines += ["### SPDR 板块跌幅前 5", ""] + _format_sector_lines(us["bottom_sectors"]) + [""]
    lines += ["## 🇭🇰 港股早盘", ""]
    if hk and hk.get("indices"):
        lines += _format_index_lines(hk["indices"]) + [""]
    else:
        lines += ["(港股数据获取失败)", ""]
    lines += ["## 📰 隔夜重要新闻", ""]
    if news_lines:
        lines += news_lines + [""]
    else:
        lines += ["(暂无可用新闻源)", ""]
    lines += ["---", f"_生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}_"]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 收盘总结
# ---------------------------------------------------------------------------

CLOSING_PROMPT_TEMPLATE = """
你是一位 A 股 / 港股盘后复盘助理。基于下方"今日 A 股 + 港股 + 板块 + 新闻"数据,
为今天的两地市场写一份盘后总结。

要求:
1. 用 2-3 个 bullet 概括 A 股大盘强弱(指数 / 涨跌家数 / 涨停 / 成交额)。
2. 用 2-3 个 bullet 概括港股表现。
3. 用 3-5 个 bullet 提炼今日热点板块 + 题材,指明扩散性和持续度判断。
4. 用 1-2 个 bullet 给出明日关注点(若有重要事件 / 数据点)。
5. 整体不超过 350 字,中性、可操作。

== 数据 ==

【A 股指数】
{cn_indices}

【A 股市场统计】
{cn_stats}

【A 股领涨板块】
{cn_top_sectors}

【A 股领跌板块】
{cn_bottom_sectors}

【港股指数】
{hk_indices}

【港股板块代表 ETF】
{hk_sectors}

【今日重要新闻】
{news}
""".strip()


class ClosingSummaryService:
    """收盘总结:A 股 + 港股 + 板块 + 新闻 + LLM 生成复盘。"""

    def __init__(self, config: Optional[Config] = None) -> None:
        self.config = config or get_config()

    def generate(self, send_notification: bool = False) -> Dict[str, Any]:
        logger.info("[Closing Summary] 开始生成收盘总结...")
        today = datetime.now().strftime("%Y-%m-%d")

        notification_service, analyzer, search_service = build_market_review_runtime(
            self.config, source_message="closing_summary"
        )

        cn_snap = _safe_fetch_dashboard("cn")
        hk_snap = _safe_fetch_dashboard("hk")

        news = _safe_fetch_watchlist_news(search_service, "A 股 收盘 热点 题材 板块")
        news_lines = _format_news_lines(news)
        news_text = "\n".join(news_lines) if news_lines else "(暂无最新新闻)"

        llm_summary = ""
        try:
            stats = (cn_snap or {}).get("market_stats") or {}
            stats_lines: List[str] = []
            if stats:
                if stats.get("up") is not None:
                    stats_lines.append(f"- 上涨 {stats.get('up')} / 下跌 {stats.get('down')} / 平盘 {stats.get('unchanged')}")
                if stats.get("limit_up") is not None:
                    stats_lines.append(f"- 涨停 {stats.get('limit_up')} / 跌停 {stats.get('limit_down')}")
                if stats.get("total_amount") is not None:
                    stats_lines.append(f"- 成交额 {stats.get('total_amount'):.2f} 亿")
            prompt = CLOSING_PROMPT_TEMPLATE.format(
                cn_indices="\n".join(_format_index_lines((cn_snap or {}).get("indices") or [])) or "(数据缺失)",
                cn_stats="\n".join(stats_lines) or "(数据缺失)",
                cn_top_sectors="\n".join(_format_sector_lines((cn_snap or {}).get("top_sectors") or [])) or "(数据缺失)",
                cn_bottom_sectors="\n".join(_format_sector_lines((cn_snap or {}).get("bottom_sectors") or [])) or "(数据缺失)",
                hk_indices="\n".join(_format_index_lines((hk_snap or {}).get("indices") or [])) or "(数据缺失)",
                hk_sectors="\n".join(_format_sector_lines(((hk_snap or {}).get("top_sectors") or []) + ((hk_snap or {}).get("bottom_sectors") or []))) or "(数据缺失)",
                news=news_text,
            )
            if analyzer is not None and hasattr(analyzer, "generate_text"):
                llm_summary = analyzer.generate_text(prompt) or ""
        except Exception as e:
            logger.warning(f"[Closing Summary] LLM 总结失败: {e}")

        markdown = _render_closing_markdown(today, cn_snap, hk_snap, news_lines, llm_summary)

        saved, query_id = _persist(
            config=self.config,
            report_type=CLOSING_SUMMARY_TYPE,
            code=CLOSING_HISTORY_CODE,
            name="收盘总结",
            summary=(llm_summary or "")[:500] or "A 股 + 港股 + 板块 + 新闻",
            markdown=markdown,
            extra_context={"date": today},
        )

        if send_notification:
            _maybe_push(notification_service, title=f"收盘总结 {today}", markdown=markdown)

        return {
            "query_id": query_id,
            "saved": saved,
            "report_type": CLOSING_SUMMARY_TYPE,
            "date": today,
            "markdown": markdown,
            "llm_summary": llm_summary,
        }


def _render_closing_markdown(
    date: str,
    cn: Optional[Dict[str, Any]],
    hk: Optional[Dict[str, Any]],
    news_lines: List[str],
    llm_summary: str,
) -> str:
    lines: List[str] = [f"# 🌇 收盘总结 {date}", ""]
    if llm_summary.strip():
        lines += ["## 💡 今日复盘(LLM)", "", llm_summary.strip(), ""]
    # A 股
    lines += ["## 📊 A 股大盘", ""]
    if cn and cn.get("indices"):
        lines += _format_index_lines(cn["indices"]) + [""]
    else:
        lines += ["(A 股数据获取失败)", ""]
    stats = (cn or {}).get("market_stats") or {}
    if stats:
        sub: List[str] = []
        if stats.get("up") is not None:
            sub.append(f"- 上涨 {stats.get('up')} / 下跌 {stats.get('down')} / 平盘 {stats.get('unchanged')}")
        if stats.get("limit_up") is not None:
            sub.append(f"- 涨停 **{stats.get('limit_up')}** / 跌停 **{stats.get('limit_down')}**")
        if stats.get("total_amount") is not None:
            sub.append(f"- 总成交额 **{stats.get('total_amount'):.2f}** 亿元")
        if sub:
            lines += ["### 涨跌统计", ""] + sub + [""]
    if cn and cn.get("top_sectors"):
        lines += ["### 🔥 领涨板块 Top 5", ""] + _format_sector_lines(cn["top_sectors"]) + [""]
    if cn and cn.get("bottom_sectors"):
        lines += ["### ❄️ 领跌板块 Top 5", ""] + _format_sector_lines(cn["bottom_sectors"]) + [""]
    # 港股
    lines += ["## 🇭🇰 港股", ""]
    if hk and hk.get("indices"):
        lines += _format_index_lines(hk["indices"]) + [""]
    else:
        lines += ["(港股数据获取失败)", ""]
    if hk and hk.get("top_sectors"):
        lines += ["### 港股板块代表 ETF", ""] + _format_sector_lines(hk["top_sectors"] + (hk.get("bottom_sectors") or [])) + [""]
    # 新闻
    lines += ["## 📰 今日重要新闻", ""]
    if news_lines:
        lines += news_lines + [""]
    else:
        lines += ["(暂无可用新闻源)", ""]
    lines += ["---", f"_生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}_"]
    return "\n".join(lines)
