# -*- coding: utf-8 -*-
"""
===================================
荐股命令（全 A 股技术选股）
===================================

对全 A 股做批量技术评分（多头排列 / 动量 / 量比 / 距 20 日高点 + 热门板块加分），
异步执行后把 Top N 候选推回来源会话。重活在后台，先回执再推送。
"""

import logging
import threading
from typing import List, Optional

from bot.commands.base import BotCommand
from bot.models import BotMessage, BotResponse

logger = logging.getLogger(__name__)

# 全市场扫描较重（~5000 只、数十秒），用进程内锁避免并发重复扫描
_recommend_lock = threading.Lock()

DEFAULT_TOP_N = 10
MAX_TOP_N = 20
# 阶段二:对前几只决赛股跑"所有 skill"完整 AI 分析。控制成本,默认只深析前 3 只。
DEEP_ANALYZE_MAX = 3
# 单股全 skill 分析 ~150s；3 只即便本地 shim 串行也需留足预算
DEEP_ANALYZE_TIMEOUT_S = 480.0


class RecommendCommand(BotCommand):
    """全 A 股技术选股推荐。"""

    @property
    def name(self) -> str:
        return "recommend"

    @property
    def aliases(self) -> List[str]:
        return ["荐股", "推荐", "选股", "rec"]

    @property
    def description(self) -> str:
        return "全 A 股技术选股推荐（多头排列 + 动量 + 量比 + 热门板块）"

    @property
    def usage(self) -> str:
        return "/recommend [数量]"

    def execute(self, message: BotMessage, args: List[str]) -> BotResponse:
        top_n = DEFAULT_TOP_N
        if args:
            try:
                top_n = int(args[0])
            except (ValueError, TypeError):
                return BotResponse.error_response(f"无效的数量: {args[0]}")
            if top_n <= 0:
                return BotResponse.error_response("数量必须大于 0")
            top_n = min(top_n, MAX_TOP_N)

        if not _recommend_lock.acquire(blocking=False):
            return BotResponse.markdown_response("⚠️ 已有一个荐股任务正在执行，请稍后再试。")

        thread = threading.Thread(
            target=self._run_recommend,
            args=(message, top_n),
            daemon=True,
        )
        try:
            thread.start()
        except Exception as exc:
            _recommend_lock.release()
            logger.error("[RecommendCommand] 后台线程启动失败: %s", exc)
            return BotResponse.error_response("荐股任务启动失败，请稍后重试")

        deep_n = min(top_n, DEEP_ANALYZE_MAX)
        return BotResponse.markdown_response(
            f"✅ **荐股任务已启动**（全 A 股技术选股，Top {top_n}）\n\n"
            "正在做：\n"
            "• 拉取全市场近 30 日行情\n"
            "• 技术评分：多头排列 / 5 日动量 / 量比 / 距 20 日高点 + 热门板块\n"
            f"• 再对前 {deep_n} 只叠加全部策略 skill 做完整 AI 分析\n\n"
            "先推技术速览，再推深度分析，全程约几分钟。"
        )

    def _run_recommend(self, message: BotMessage, top_n: int) -> None:
        """后台执行全 A 股选股并把结果推回来源会话。"""
        try:
            from src.config import get_config
            from src.notification import NotificationService
            from src.services.recommendation_service import recommend

            config = get_config()
            watchlist = list(getattr(config, "stock_list", []) or [])

            result = recommend(top_n=top_n, pool="all_a", watchlist=watchlist)
            content = self._format_result(result, top_n)

            notifier = NotificationService(source_message=message)
            notifier.send(content, email_send_to_all=True, route_type="report")
            logger.info("[RecommendCommand] 荐股完成并已推送，候选 %d 只", len(result.get("candidates", [])))

            # 阶段二:对前几只决赛股跑"所有 skill"完整 AI 分析,再推一条深度报告
            candidates = result.get("candidates", []) or []
            if candidates:
                deep = self._deep_analyze(message, candidates)
                if deep:
                    NotificationService(source_message=message).send(
                        deep, email_send_to_all=True, route_type="report"
                    )
        except Exception as e:
            logger.error("[RecommendCommand] 荐股失败: %s", e)
            logger.exception(e)
            try:
                from src.notification import NotificationService
                NotificationService(source_message=message).send(
                    f"❌ 荐股任务执行失败：{str(e)[:120]}",
                    route_type="report",
                )
            except Exception:
                pass
        finally:
            if _recommend_lock.locked():
                _recommend_lock.release()

    def _deep_analyze(self, message: BotMessage, candidates: list) -> Optional[str]:
        """对前 DEEP_ANALYZE_MAX 只决赛股，叠加全部 skill 跑完整 AI 分析，返回 markdown。"""
        from concurrent.futures import (
            ThreadPoolExecutor,
            TimeoutError as FutureTimeoutError,
            as_completed,
        )

        targets = [c for c in candidates[:DEEP_ANALYZE_MAX] if c.get("code")]
        if not targets:
            return None

        try:
            from src.config import get_config
            from src.agent.factory import build_agent_executor, get_skill_manager
            from bot.commands.ask import AskCommand

            config = get_config()
            if not getattr(config, "agent_mode", False):
                logger.info("[RecommendCommand] AGENT_MODE 未开，跳过深度分析")
                return None
            skill_ids = [
                str(getattr(s, "name", "")).strip()
                for s in get_skill_manager(config).list_skills()
            ]
            skill_ids = [s for s in skill_ids if s]
        except Exception as e:
            logger.warning("[RecommendCommand] 深度分析初始化失败: %s", e)
            return None

        def _run_one(code: str, name: str):
            try:
                executor = build_agent_executor(config, skills=skill_ids or None)
                user_msg = (
                    f"请综合所有可用交易策略，对股票 {code} {name} 给出完整决策："
                    "趋势研判、理想买点、止损位、目标位与建议仓位。"
                )
                ctx = {"stock_code": code, "skills": skill_ids, "strategies": skill_ids}
                result = executor.run(task=user_msg, context=ctx)
                dashboard = result.dashboard if isinstance(getattr(result, "dashboard", None), dict) else None
                md = AskCommand._format_stock_result(code, dashboard, getattr(result, "content", "") or "")
                return code, name, (md or None)
            except Exception as e:
                logger.warning("[RecommendCommand] %s 深度分析失败: %s", code, e)
                return code, name, None

        out: dict = {}
        with ThreadPoolExecutor(max_workers=min(len(targets), DEEP_ANALYZE_MAX)) as pool:
            fut = {pool.submit(_run_one, c["code"], c.get("name") or ""): c["code"] for c in targets}
            try:
                for f in as_completed(fut, timeout=DEEP_ANALYZE_TIMEOUT_S):
                    code, name, md = f.result(timeout=5)
                    if md:
                        out[code] = (name, md)
            except FutureTimeoutError:
                logger.warning("[RecommendCommand] 深度分析整体超时（%.0fs）", DEEP_ANALYZE_TIMEOUT_S)
            finally:
                pool.shutdown(wait=False, cancel_futures=True)

        if not out:
            return None

        lines = [
            f"🔬 **Top {len(out)} 决赛股 · 全策略深度分析**",
            "_已叠加全部交易策略 skill；仅供参考，不构成投资建议_",
            "",
        ]
        for c in targets:
            code = c["code"]
            if code in out:
                name, md = out[code]
                lines.append(f"### {code} {name}".rstrip())
                lines.append(md)
                lines.append("")
        return "\n".join(lines)

    @staticmethod
    def _format_result(result: dict, top_n: int) -> str:
        candidates = result.get("candidates", []) or []
        hot_sectors = result.get("hot_sectors", []) or []
        pool_size = result.get("pool_size")
        price_as_of = result.get("price_as_of")

        lines: List[str] = [f"🎯 **全 A 股技术选股 Top {len(candidates)}**", ""]
        if pool_size:
            lines.append(f"_筛选范围：全 A 股 {pool_size} 只_")
        if hot_sectors:
            lines.append("🔥 今日领涨板块：" + " / ".join(hot_sectors[:5]))
        lines.append(
            f"_现价：实时报价 (as_of {price_as_of})_" if price_as_of else "_现价：T-1 日 K 收盘_"
        )
        lines.append("")

        if not candidates:
            lines.append("未筛出符合条件的候选（可能今日普遍走弱或数据源受限）。")
            return "\n".join(lines)

        for i, c in enumerate(candidates, 1):
            name = c.get("name") or ""
            signals = " / ".join(c.get("signals", []) or []) or "-"
            lines.append(
                f"**{i}. {c.get('code')} {name}**　评分 {c.get('score')}\n"
                f"现价 {c.get('last_price', 0):.2f}　{c.get('change_pct', 0):+.2f}%　"
                f"{c.get('industry') or '-'}\n"
                f"信号：{signals}"
            )
            lines.append("")

        lines.append("────────")
        lines.append("> 仅基于技术面（MA 排列 / 动量 / 量比 / 距 20 日高点 + 热门板块），不含基本面与新闻。")
        lines.append("> 要对某只出完整 AI 决策报告，发送 `/ask <代码>`。")
        return "\n".join(lines)
