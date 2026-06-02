# -*- coding: utf-8 -*-
"""
Tests for fundamental adapter helpers.
"""

import os
import sys
import unittest
import unittest.mock
from datetime import datetime, timedelta
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from data_provider.fundamental_adapter import (
    AkshareFundamentalAdapter,
    _build_dividend_payload,
    _extract_latest_row,
    _parse_dividend_plan_to_per_share,
)


class TestFundamentalAdapter(unittest.TestCase):
    def setUp(self) -> None:
        # 类级 sina 缓存可能被前一个测试污染，每次测试前清空
        AkshareFundamentalAdapter._sina_lhb_cache.clear()

    def test_parse_dividend_plan_to_per_share_supports_cn_patterns(self) -> None:
        self.assertAlmostEqual(_parse_dividend_plan_to_per_share("10派3元(含税)"), 0.3, places=6)
        self.assertAlmostEqual(_parse_dividend_plan_to_per_share("每10股派发2.5元"), 0.25, places=6)
        self.assertAlmostEqual(_parse_dividend_plan_to_per_share("每股派0.8元"), 0.8, places=6)
        self.assertIsNone(_parse_dividend_plan_to_per_share("仅送股，不现金分红"))

    def test_extract_latest_row_returns_none_when_code_mismatch(self) -> None:
        df = pd.DataFrame(
            {
                "股票代码": ["600000", "000001"],
                "值": [1, 2],
            }
        )
        row = _extract_latest_row(df, "600519")
        self.assertIsNone(row)

    def test_extract_latest_row_fallback_when_no_code_column(self) -> None:
        df = pd.DataFrame({"值": [1, 2]})
        row = _extract_latest_row(df, "600519")
        self.assertIsNotNone(row)
        self.assertEqual(row["值"], 1)

    def test_dragon_tiger_no_match_with_code_column_is_ok(self) -> None:
        adapter = AkshareFundamentalAdapter()
        df = pd.DataFrame(
            {
                "股票代码": ["600000"],
                "日期": ["2026-01-01"],
            }
        )
        with patch.object(
            adapter, "_dragon_tiger_via_sina", return_value=None
        ), patch.object(
            adapter, "_call_df_candidates",
            return_value=(df, "stock_lhb_stock_statistic_em", []),
        ):
            result = adapter.get_dragon_tiger_flag("600519")
        self.assertEqual(result["status"], "ok")
        self.assertFalse(result["is_on_list"])
        self.assertEqual(result["recent_count"], 0)

    def test_dragon_tiger_match_is_ok(self) -> None:
        adapter = AkshareFundamentalAdapter()
        today = pd.Timestamp.now().strftime("%Y-%m-%d")
        df = pd.DataFrame(
            {
                "股票代码": ["600519"],
                "日期": [today],
            }
        )
        with patch.object(
            adapter, "_dragon_tiger_via_sina", return_value=None
        ), patch.object(
            adapter, "_call_df_candidates",
            return_value=(df, "stock_lhb_stock_statistic_em", []),
        ):
            result = adapter.get_dragon_tiger_flag("600519")
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["is_on_list"])
        self.assertGreaterEqual(result["recent_count"], 1)

    def test_capital_flow_uses_xueqiu_when_cookie_configured(self) -> None:
        """配置了 XUEQIU_COOKIE 时，stock_flow 应取自雪球，不打 akshare。"""
        adapter = AkshareFundamentalAdapter()
        sample = {
            "data": {
                "sum5": 800_000_000.0,
                "sum10": -200_000_000.0,
                "items": [
                    {"amount": 100_000_000.0, "timestamp": 1700000000000},
                    {"amount": 50_000_000.0, "timestamp": 1700086400000},
                ],
            },
            "error_code": 0,
        }
        mock_resp = unittest.mock.MagicMock()
        mock_resp.json = unittest.mock.MagicMock(return_value=sample)
        mock_resp.raise_for_status = unittest.mock.MagicMock()

        with patch.dict(os.environ, {"XUEQIU_COOKIE": "xq_a_token=fake"}, clear=False), \
             patch("data_provider.fundamental_adapter.requests.get", return_value=mock_resp) as get_mock, \
             patch.object(
                 adapter, "_call_df_candidates", return_value=(None, None, [])
             ) as call_mock:
            # 重置 cooldown
            AkshareFundamentalAdapter._xueqiu_capital_last_fail_ts = 0.0
            result = adapter.get_capital_flow("600519")

        # 资金流字段应该来自雪球
        self.assertEqual(result["stock_flow"]["main_net_inflow"], 50_000_000.0)
        self.assertEqual(result["stock_flow"]["inflow_5d"], 800_000_000.0)
        self.assertEqual(result["stock_flow"]["inflow_10d"], -200_000_000.0)
        # source_chain 标记 xueqiu_capital_history
        self.assertTrue(
            any("xueqiu_capital_history" in s for s in result["source_chain"])
        )
        # 走了雪球，akshare stock_individual_fund_flow 候选链不应被调
        # （但板块 capital flow 还会调 stock_sector_fund_flow_rank）
        for args, _ in call_mock.call_args_list:
            candidates = args[0]
            for fn_name, _ in candidates:
                self.assertNotEqual(fn_name, "stock_individual_fund_flow")

        # 入参校验：URL + symbol 前缀
        get_mock.assert_called_once()
        kwargs = get_mock.call_args.kwargs
        self.assertIn("symbol", kwargs.get("params", {}))
        self.assertEqual(kwargs["params"]["symbol"], "SH600519")

    def test_capital_flow_xueqiu_szse_routing(self) -> None:
        """000001 深圳股应路由到 SZ 前缀。"""
        adapter = AkshareFundamentalAdapter()
        mock_resp = unittest.mock.MagicMock()
        mock_resp.json = unittest.mock.MagicMock(
            return_value={"data": {"items": [], "sum5": 0, "sum10": 0}, "error_code": 0}
        )
        mock_resp.raise_for_status = unittest.mock.MagicMock()

        with patch.dict(os.environ, {"XUEQIU_COOKIE": "xq_a_token=fake"}, clear=False), \
             patch("data_provider.fundamental_adapter.requests.get", return_value=mock_resp) as get_mock, \
             patch.object(adapter, "_call_df_candidates", return_value=(None, None, [])):
            AkshareFundamentalAdapter._xueqiu_capital_last_fail_ts = 0.0
            adapter.get_capital_flow("000001")

        self.assertEqual(get_mock.call_args.kwargs["params"]["symbol"], "SZ000001")

    def test_capital_flow_xueqiu_cooldown_after_failure(self) -> None:
        """请求失败应进入 5 分钟冷却，期间不再打雪球。"""
        adapter = AkshareFundamentalAdapter()
        AkshareFundamentalAdapter._xueqiu_capital_last_fail_ts = 0.0

        with patch.dict(os.environ, {"XUEQIU_COOKIE": "xq_a_token=fake"}, clear=False), \
             patch(
                 "data_provider.fundamental_adapter.requests.get",
                 side_effect=RuntimeError("network down"),
             ) as get_mock, \
             patch.object(adapter, "_call_df_candidates", return_value=(None, None, [])):
            adapter.get_capital_flow("600519")
            adapter.get_capital_flow("600519")
            adapter.get_capital_flow("600519")

        # 第一次打 → 失败 → 冷却；后两次不打
        self.assertEqual(get_mock.call_count, 1)

    def test_capital_flow_falls_back_to_akshare_when_no_cookie(self) -> None:
        """未配置 XUEQIU_COOKIE 时不应碰雪球，仍走 akshare 候选链。"""
        adapter = AkshareFundamentalAdapter()

        with patch.dict(os.environ, {"XUEQIU_COOKIE": ""}, clear=False), \
             patch("data_provider.fundamental_adapter.requests.get") as get_mock, \
             patch.object(adapter, "_call_df_candidates", return_value=(None, None, [])):
            AkshareFundamentalAdapter._xueqiu_capital_last_fail_ts = 0.0
            adapter.get_capital_flow("600519")

        get_mock.assert_not_called()

    def test_dragon_tiger_sina_path_short_circuits_em(self) -> None:
        """sina 接口返回非空 DataFrame 时不应再调用东财候选链。"""
        adapter = AkshareFundamentalAdapter()
        sina_df = pd.DataFrame(
            {
                "股票代码": ["002185"],
                "股票名称": ["华天科技"],
                "上榜次数": [4],
                "累积购买额": [1208122.4],
            }
        )
        em_call_mock = unittest.mock.MagicMock(
            return_value=(None, None, ["stock_lhb_stock_statistic_em:Blocked"])
        )

        original_call = adapter._call_df_candidates

        def fake_call(candidates):
            # 第一次调用是 sina 路径，返回真数据；后续才走 em
            if candidates and candidates[0][0] == "stock_lhb_ggtj_sina":
                return (sina_df, "stock_lhb_ggtj_sina", [])
            return em_call_mock(candidates)

        with patch.object(adapter, "_call_df_candidates", side_effect=fake_call):
            result = adapter.get_dragon_tiger_flag("002185", lookback_days=20)

        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["is_on_list"])
        self.assertEqual(result["recent_count"], 4)
        self.assertTrue(
            any("stock_lhb_ggtj_sina" in s for s in result["source_chain"])
        )
        em_call_mock.assert_not_called()

    def test_dragon_tiger_sina_path_returns_zero_when_not_on_list(self) -> None:
        """sina 接口数据存在但目标股票未上榜：is_on_list=False, recent_count=0。"""
        adapter = AkshareFundamentalAdapter()
        sina_df = pd.DataFrame(
            {
                "股票代码": ["000001"],
                "股票名称": ["平安银行"],
                "上榜次数": [2],
            }
        )

        with patch.object(
            adapter,
            "_call_df_candidates",
            return_value=(sina_df, "stock_lhb_ggtj_sina", []),
        ):
            result = adapter.get_dragon_tiger_flag("600519", lookback_days=20)

        self.assertEqual(result["status"], "ok")
        self.assertFalse(result["is_on_list"])
        self.assertEqual(result["recent_count"], 0)

    def test_fundamental_bundle_includes_financial_report_and_dividend_payload(self) -> None:
        adapter = AkshareFundamentalAdapter()
        now = datetime.now()
        within_ttm = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        future_day = (now + timedelta(days=10)).strftime("%Y-%m-%d")
        old_day = (now - timedelta(days=500)).strftime("%Y-%m-%d")
        fin_df = pd.DataFrame(
            {
                "股票代码": ["600519"],
                "报告期": [within_ttm],
                "营业总收入": [1000.0],
                "归母净利润": [300.0],
                "经营活动产生的现金流量净额": [500.0],
                "净资产收益率": [18.2],
                "营业收入同比": [12.0],
                "净利润同比": [9.5],
            }
        )
        forecast_df = pd.DataFrame({"股票代码": ["600519"], "预告": ["预增"]})
        quick_df = pd.DataFrame({"股票代码": ["600519"], "快报": ["快报摘要"]})
        dividend_df = pd.DataFrame(
            {
                "股票代码": ["600519", "600519", "600519", "600519"],
                "除息日": [within_ttm, within_ttm, future_day, old_day],
                "分配方案": ["10派3元(含税)", "10派3元(含税)", "10派5元", "10派1元"],
            }
        )

        with patch.object(
            adapter,
            "_call_df_candidates",
            side_effect=[
                (fin_df, "stock_financial_abstract", []),
                (forecast_df, "stock_yjyg_em", []),
                (quick_df, "stock_yjkb_em", []),
                (dividend_df, "stock_fhps_detail_em", []),
                (None, None, []),
                (None, None, []),
            ],
        ):
            result = adapter.get_fundamental_bundle("600519")

        financial_report = result["earnings"].get("financial_report", {})
        self.assertEqual(financial_report.get("report_date"), within_ttm)
        self.assertEqual(financial_report.get("revenue"), 1000.0)
        self.assertEqual(financial_report.get("net_profit_parent"), 300.0)
        self.assertEqual(financial_report.get("operating_cash_flow"), 500.0)
        self.assertEqual(financial_report.get("roe"), 18.2)

        dividend_payload = result["earnings"].get("dividend", {})
        events = dividend_payload.get("events", [])
        self.assertEqual(len(events), 2)  # duplicate + future day filtered
        self.assertEqual(dividend_payload.get("ttm_event_count"), 1)
        self.assertAlmostEqual(dividend_payload.get("ttm_cash_dividend_per_share"), 0.3, places=6)

    def test_build_dividend_payload_returns_empty_when_code_not_matched(self) -> None:
        now = datetime.now().strftime("%Y-%m-%d")
        df = pd.DataFrame(
            {
                "股票代码": ["000001"],
                "除息日": [now],
                "分配方案": ["10派3元(含税)"],
            }
        )

        payload = _build_dividend_payload(df, stock_code="600519")
        self.assertEqual(payload, {})

    def test_build_dividend_payload_skips_after_tax_plan(self) -> None:
        now = datetime.now().strftime("%Y-%m-%d")
        df = pd.DataFrame(
            {
                "股票代码": ["600519"],
                "除息日": [now],
                "分配方案": ["10派3元(税后)"],
            }
        )

        payload = _build_dividend_payload(df, stock_code="600519")
        self.assertEqual(payload, {})

    def test_build_dividend_payload_ttm_window_boundary(self) -> None:
        now = datetime.now()
        day_365 = (now - timedelta(days=365)).strftime("%Y-%m-%d")
        day_366 = (now - timedelta(days=366)).strftime("%Y-%m-%d")
        df = pd.DataFrame(
            {
                "股票代码": ["600519", "600519"],
                "除息日": [day_365, day_366],
                "分配方案": ["10派3元(含税)", "10派5元(含税)"],
            }
        )

        payload = _build_dividend_payload(df, stock_code="600519")
        self.assertEqual(payload.get("ttm_event_count"), 1)
        self.assertAlmostEqual(payload.get("ttm_cash_dividend_per_share"), 0.3, places=6)


if __name__ == "__main__":
    unittest.main()
