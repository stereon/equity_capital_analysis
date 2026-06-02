# -*- coding: utf-8 -*-
"""Tests for EastmoneyStockNewsProvider — A 股个股新闻兜底搜索。"""

import sys
import unittest
from datetime import datetime, timedelta
from types import ModuleType
from unittest.mock import MagicMock, patch

import pandas as pd

# Mock newspaper before search_service import (optional dependency)
if "newspaper" not in sys.modules:
    mock_np = MagicMock()
    mock_np.Article = MagicMock()
    mock_np.Config = MagicMock()
    sys.modules["newspaper"] = mock_np


from src.search_service import EastmoneyStockNewsProvider


class TestEastmoneyStockNewsProvider(unittest.TestCase):
    def setUp(self) -> None:
        self.provider = EastmoneyStockNewsProvider()

    def test_is_available_without_api_key(self) -> None:
        self.assertTrue(self.provider.is_available)

    def test_extract_stock_code(self) -> None:
        self.assertEqual(
            EastmoneyStockNewsProvider._extract_stock_code(
                "贵州茅台 600519 股票 最新消息"
            ),
            "600519",
        )
        self.assertIsNone(
            EastmoneyStockNewsProvider._extract_stock_code("AAPL Apple")
        )

    def test_do_search_returns_empty_when_no_stock_code(self) -> None:
        resp = self.provider._do_search(
            query="股票市场最新动态",
            api_key="",
            max_results=5,
            days=7,
        )
        self.assertTrue(resp.success)
        self.assertEqual(resp.results, [])

    def test_do_search_maps_akshare_df_to_results(self) -> None:
        today = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        sample = pd.DataFrame([
            {
                "关键词": "贵州茅台",
                "新闻标题": "贵州茅台一季报净利润 272 亿同比增长 1.47%",
                "新闻内容": "贵州茅台发布 2026 年一季报，营业总收入 547 亿元 ...",
                "发布时间": today,
                "文章来源": "证券时报",
                "新闻链接": "http://example.com/news/1",
            },
            {
                "关键词": "贵州茅台",
                "新闻标题": "贵州茅台完成回购 30 亿元",
                "新闻内容": "贵州茅台公告：股份回购实施完成 ...",
                "发布时间": today,
                "文章来源": "财联社",
                "新闻链接": "http://example.com/news/2",
            },
        ])
        fake_ak = ModuleType("akshare")
        fake_ak.stock_news_em = MagicMock(return_value=sample)

        with patch.dict(sys.modules, {"akshare": fake_ak}):
            resp = self.provider._do_search(
                query="贵州茅台 600519 最新消息",
                api_key="",
                max_results=5,
                days=30,
            )

        self.assertTrue(resp.success)
        self.assertEqual(len(resp.results), 2)
        first = resp.results[0]
        self.assertEqual(first.title, "贵州茅台一季报净利润 272 亿同比增长 1.47%")
        self.assertEqual(first.source, "证券时报")
        self.assertIn("一季报", first.snippet)
        self.assertEqual(first.url, "http://example.com/news/1")
        # akshare 应被传入 symbol=600519
        fake_ak.stock_news_em.assert_called_once_with(symbol="600519")

    def test_do_search_filters_by_date_window(self) -> None:
        today = datetime.now()
        in_window = (today - timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S")
        out_of_window = (today - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
        sample = pd.DataFrame([
            {
                "新闻标题": "fresh news",
                "新闻内容": "...",
                "发布时间": in_window,
                "文章来源": "x", "新闻链接": "x",
            },
            {
                "新闻标题": "old news",
                "新闻内容": "...",
                "发布时间": out_of_window,
                "文章来源": "x", "新闻链接": "x",
            },
        ])
        fake_ak = ModuleType("akshare")
        fake_ak.stock_news_em = MagicMock(return_value=sample)

        with patch.dict(sys.modules, {"akshare": fake_ak}):
            resp = self.provider._do_search(
                query="600519",
                api_key="",
                max_results=5,
                days=7,
            )

        titles = [r.title for r in resp.results]
        self.assertIn("fresh news", titles)
        self.assertNotIn("old news", titles)

    def test_do_search_handles_akshare_failure(self) -> None:
        fake_ak = ModuleType("akshare")
        fake_ak.stock_news_em = MagicMock(side_effect=RuntimeError("api down"))
        with patch.dict(sys.modules, {"akshare": fake_ak}):
            resp = self.provider._do_search(
                query="600519",
                api_key="",
                max_results=5,
                days=7,
            )
        self.assertFalse(resp.success)
        self.assertEqual(resp.results, [])
        self.assertIn("api down", resp.error_message or "")

    def test_do_search_handles_empty_df(self) -> None:
        fake_ak = ModuleType("akshare")
        fake_ak.stock_news_em = MagicMock(return_value=pd.DataFrame())
        with patch.dict(sys.modules, {"akshare": fake_ak}):
            resp = self.provider._do_search(
                query="600519",
                api_key="",
                max_results=5,
                days=7,
            )
        self.assertTrue(resp.success)
        self.assertEqual(resp.results, [])


if __name__ == "__main__":
    unittest.main()
