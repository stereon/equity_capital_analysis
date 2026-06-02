# -*- coding: utf-8 -*-
"""Regression tests for post-merge Tushare follow-up fixes."""

import importlib.util
import sys
import unittest
from datetime import datetime
from unittest.mock import MagicMock, patch

import pandas as pd

from tests.litellm_stub import ensure_litellm_stub

ensure_litellm_stub()

try:
    json_repair_available = importlib.util.find_spec("json_repair") is not None
except ValueError:
    json_repair_available = "json_repair" in sys.modules

if not json_repair_available and "json_repair" not in sys.modules:
    sys.modules["json_repair"] = MagicMock()

from data_provider.tushare_fetcher import TushareFetcher


class TestTushareFetcherFollowUps(unittest.TestCase):
    """Cover rate limiting and cross-day trade-calendar refresh behavior."""

    def setUp(self) -> None:
        # 默认禁用本地 exchange_calendars 路径，让既有测试继续走 trade_cal API
        # 验证频率限制 / 缓存刷新等行为；专门测本地路径的 case 会单独 stop 它。
        self._local_resolver_patcher = patch.object(
            TushareFetcher, "_resolve_local_trade_dates", return_value=[]
        )
        self._local_resolver_patcher.start()
        self.addCleanup(self._local_resolver_patcher.stop)

    @staticmethod
    def _make_fetcher() -> TushareFetcher:
        with patch.object(TushareFetcher, "_init_api", return_value=None):
            fetcher = TushareFetcher()
        fetcher._api = MagicMock()
        fetcher.priority = 2
        return fetcher

    def test_stock_basic_cache_returns_same_df_within_ttl(self) -> None:
        """24h 内的二次调用应直接返回内存缓存，不再打 API。"""
        fetcher = self._make_fetcher()
        sample = pd.DataFrame({
            "ts_code": ["600519.SH", "000001.SZ"],
            "name": ["贵州茅台", "平安银行"],
            "industry": ["白酒", "银行"],
            "area": ["贵州", "深圳"],
            "market": ["主板", "主板"],
        })
        fetcher._api.stock_basic.return_value = sample

        with patch.object(fetcher, "_check_rate_limit"):
            first = fetcher._get_stock_basic_cached()
            second = fetcher._get_stock_basic_cached()

        self.assertIsNotNone(first)
        self.assertIs(first, second)  # 同一个 DataFrame 对象 == 缓存命中
        self.assertEqual(fetcher._api.stock_basic.call_count, 1)
        # name 缓存应被同步填好
        self.assertEqual(fetcher._stock_name_cache.get("600519"), "贵州茅台")
        self.assertEqual(fetcher._stock_name_cache.get("000001"), "平安银行")

    def test_stock_basic_cache_cooldown_skips_api_after_failure(self) -> None:
        """API 失败后进入 5 分钟冷却期：后续调用不再打 stock_basic。"""
        fetcher = self._make_fetcher()
        fetcher._api.stock_basic.side_effect = RuntimeError("rate limit hit")

        with patch.object(fetcher, "_check_rate_limit"):
            first = fetcher._get_stock_basic_cached()
            second = fetcher._get_stock_basic_cached()
            third = fetcher._get_stock_basic_cached()

        self.assertIsNone(first)
        self.assertIsNone(second)
        self.assertIsNone(third)
        # 仅第一次真的打了 API；后两次因为冷却中直接返回（仍是 None）
        self.assertEqual(fetcher._api.stock_basic.call_count, 1)

    def test_stock_basic_cache_falls_back_to_stale_on_api_failure(self) -> None:
        """缓存已有时，API 失败应保留旧缓存（不清空）。"""
        fetcher = self._make_fetcher()
        sample = pd.DataFrame({
            "ts_code": ["600519.SH"],
            "name": ["贵州茅台"],
            "industry": ["白酒"],
            "area": ["贵州"],
            "market": ["主板"],
        })
        fetcher._api.stock_basic.return_value = sample
        with patch.object(fetcher, "_check_rate_limit"):
            fetcher._get_stock_basic_cached()

        # 让 TTL 立即过期，触发刷新尝试
        fetcher._stock_basic_cache_ts = 0.0
        fetcher._api.stock_basic.side_effect = RuntimeError("rate limit")

        with patch.object(fetcher, "_check_rate_limit"):
            stale = fetcher._get_stock_basic_cached()

        self.assertIsNotNone(stale)
        self.assertEqual(stale.iloc[0]["name"], "贵州茅台")

    def test_get_stock_name_uses_stock_basic_cache(self) -> None:
        """单股名称查询应走缓存全表，不再单独打 stock_basic。"""
        fetcher = self._make_fetcher()
        sample = pd.DataFrame({
            "ts_code": ["600519.SH"],
            "name": ["贵州茅台"],
            "industry": ["白酒"],
            "area": ["贵州"],
            "market": ["主板"],
        })
        fetcher._api.stock_basic.return_value = sample

        with patch.object(fetcher, "_check_rate_limit"):
            # 第一次会走全表填缓存
            name = fetcher.get_stock_name("600519")
            # 第二次直接命中 _stock_name_cache
            name2 = fetcher.get_stock_name("600519")

        self.assertEqual(name, "贵州茅台")
        self.assertEqual(name2, "贵州茅台")
        # 只调一次 stock_basic（全表）；命中 stock_name_cache 后不再调
        self.assertEqual(fetcher._api.stock_basic.call_count, 1)

    def test_local_calendar_short_circuits_trade_cal(self) -> None:
        """本地 exchange_calendars 可用时不应调用 Tushare trade_cal 接口。"""
        # 临时关闭 setUp 里的 patcher，让真实的本地解析跑起来
        self._local_resolver_patcher.stop()
        try:
            fetcher = self._make_fetcher()
            with patch.object(
                fetcher,
                "_get_china_now",
                return_value=datetime(2026, 5, 29, 16, 0),
            ), patch.object(fetcher, "_check_rate_limit") as rate_limit_mock:
                dates = fetcher._get_trade_dates()
        finally:
            self._local_resolver_patcher.start()

        # 应至少包含 5 月 27/28/29 这些交易日，且不打 trade_cal API
        self.assertIn("20260529", dates)
        self.assertIn("20260528", dates)
        self.assertEqual(fetcher._api.trade_cal.call_count, 0)
        self.assertEqual(rate_limit_mock.call_count, 0)

    def test_get_trade_time_refreshes_trade_calendar_when_day_changes(self) -> None:
        fetcher = self._make_fetcher()
        fetcher._api.trade_cal.side_effect = [
            pd.DataFrame({"cal_date": ["20260317", "20260314"], "is_open": [1, 1]}),
            pd.DataFrame({"cal_date": ["20260318", "20260317"], "is_open": [1, 1]}),
        ]

        with patch.object(
            fetcher,
            "_get_china_now",
            side_effect=[
                datetime(2026, 3, 17, 20, 0),
                datetime(2026, 3, 17, 20, 0),
                datetime(2026, 3, 18, 20, 0),
                datetime(2026, 3, 18, 20, 0),
            ],
        ), patch.object(fetcher, "_check_rate_limit") as rate_limit_mock:
            self.assertEqual(fetcher.get_trade_time(early_time="00:00", late_time="19:00"), "20260317")
            self.assertEqual(fetcher.get_trade_time(early_time="00:00", late_time="19:00"), "20260318")

        self.assertEqual(fetcher._api.trade_cal.call_count, 2)
        self.assertEqual(rate_limit_mock.call_count, 2)
    def test_get_trade_time_returns_latest_trade_date_on_non_trade_day(self) -> None:
        """Non-trade day (e.g. Saturday) should return the most recent trade
        date (Friday), not the one before it (Thursday).  Fixes #1009."""
        fetcher = self._make_fetcher()
        # 2026-03-21 is Saturday; Friday 20 and Thursday 19 are trade dates
        fetcher._api.trade_cal.return_value = pd.DataFrame(
            {
                "cal_date": ["20260314", "20260315", "20260316",
                             "20260317", "20260318", "20260319",
                             "20260320", "20260321"],
                "is_open": [0, 0, 1, 1, 1, 1, 1, 0],
            }
        )

        with patch.object(
            fetcher,
            "_get_china_now",
            # called twice: once by get_trade_time, once by _get_trade_dates
            side_effect=[datetime(2026, 3, 21, 10, 0)] * 2,
        ), patch.object(fetcher, "_check_rate_limit"):
            result = fetcher.get_trade_time(early_time="00:00", late_time="19:00")

        # Should be Friday (20th), NOT Thursday (19th)
        self.assertEqual(result, "20260320")

    def test_get_trade_time_trade_day_before_data_ready_returns_previous(self) -> None:
        """On a trade day within the early-late window, should return the
        previous trade date (data not ready yet for today)."""
        fetcher = self._make_fetcher()
        fetcher._api.trade_cal.return_value = pd.DataFrame(
            {
                "cal_date": ["20260319", "20260320"],
                "is_open": [1, 1],
            }
        )

        with patch.object(
            fetcher,
            "_get_china_now",
            # Friday 10:00 AM - within 00:00~19:00 window, data not ready
            side_effect=[datetime(2026, 3, 20, 10, 0)] * 2,
        ), patch.object(fetcher, "_check_rate_limit"):
            result = fetcher.get_trade_time(early_time="00:00", late_time="19:00")

        # Data not ready, should fall back to Thursday (19th)
        self.assertEqual(result, "20260319")
        
          
    def test_get_sector_rankings_rate_limits_calendar_and_rankings_api(self) -> None:
        fetcher = self._make_fetcher()
        fetcher._api.trade_cal.return_value = pd.DataFrame(
            {"cal_date": ["20260317", "20260314"], "is_open": [1, 1]}
        )
        fetcher._api.moneyflow_ind_ths.return_value = pd.DataFrame(
            {
                "industry": ["AI", "消费"],
                "pct_change": [1.8, -0.6],
            }
        )

        with patch.object(fetcher, "_get_china_now", return_value=datetime(2026, 3, 17, 16, 0)), patch.object(
            fetcher, "_check_rate_limit"
        ) as rate_limit_mock:
            top, bottom = fetcher.get_sector_rankings(n=1)

        self.assertEqual(top, [{"name": "AI", "change_pct": 1.8}])
        self.assertEqual(bottom, [{"name": "消费", "change_pct": -0.6}])
        self.assertEqual(rate_limit_mock.call_count, 2)

    def test_get_chip_distribution_rate_limits_all_tushare_calls(self) -> None:
        fetcher = self._make_fetcher()
        fetcher._api.trade_cal.return_value = pd.DataFrame(
            {"cal_date": ["20260317", "20260314"], "is_open": [1, 1]}
        )
        fetcher._api.cyq_chips.return_value = pd.DataFrame(
            {
                "price": [9.0, 10.0, 11.0],
                "percent": [20.0, 50.0, 30.0],
            }
        )
        fetcher._api.daily.return_value = pd.DataFrame({"close": [10.5]})

        with patch.object(fetcher, "_get_china_now", return_value=datetime(2026, 3, 17, 20, 0)), patch.object(
            fetcher, "_check_rate_limit"
        ) as rate_limit_mock:
            chip = fetcher.get_chip_distribution("600519")

        self.assertIsNotNone(chip)
        if chip is None:
            self.fail("expected chip distribution data")
        self.assertEqual(chip.date, "2026-03-17")
        self.assertAlmostEqual(chip.profit_ratio, 0.7)
        self.assertAlmostEqual(chip.avg_cost, 10.1)
        self.assertAlmostEqual(chip.concentration_90, 0.1)
        self.assertAlmostEqual(chip.concentration_70, 0.1)
        self.assertEqual(rate_limit_mock.call_count, 3)

    def test_convert_stock_code_accepts_exchange_prefixed_a_share(self) -> None:
        fetcher = self._make_fetcher()

        self.assertEqual(fetcher._convert_stock_code("SZ000001"), "000001.SZ")
        self.assertEqual(fetcher._convert_stock_code("SH600519"), "600519.SH")
        self.assertEqual(fetcher._convert_stock_code("600519.SS"), "600519.SH")

    @patch.dict(sys.modules, {"tushare": MagicMock()})
    def test_legacy_realtime_quote_keeps_sz_hint_as_stock_symbol(self) -> None:
        fetcher = self._make_fetcher()
        fetcher._api.quotation.side_effect = Exception("quota")

        tushare_module = sys.modules["tushare"]
        tushare_module.get_realtime_quotes.return_value = pd.DataFrame(
            [
                {
                    "name": "平安银行",
                    "price": "10.94",
                    "pre_close": "10.88",
                    "volume": "1000",
                    "amount": "2000",
                    "high": "11.00",
                    "low": "10.80",
                    "open": "10.90",
                }
            ]
        )

        quote = fetcher.get_realtime_quote("SZ000001")

        self.assertIsNotNone(quote)
        self.assertEqual(quote.code, "000001")
        self.assertEqual(quote.name, "平安银行")
        tushare_module.get_realtime_quotes.assert_called_once_with("000001")
