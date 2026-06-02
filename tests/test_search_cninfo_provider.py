# -*- coding: utf-8 -*-
"""
Tests for CninfoSearchProvider — A 股公告兜底搜索。
"""

import sys
import unittest
from datetime import datetime
from unittest.mock import MagicMock, patch

# Mock newspaper before search_service import (optional dependency)
if "newspaper" not in sys.modules:
    mock_np = MagicMock()
    mock_np.Article = MagicMock()
    mock_np.Config = MagicMock()
    sys.modules["newspaper"] = mock_np


from src.search_service import CninfoSearchProvider


def _make_response(json_payload, status_code=200):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json = MagicMock(return_value=json_payload)
    resp.raise_for_status = MagicMock()
    return resp


class TestCninfoSearchProvider(unittest.TestCase):
    def setUp(self) -> None:
        self.provider = CninfoSearchProvider()

    def test_is_available_without_api_key(self) -> None:
        # cninfo 公开接口无需 API Key，应始终可用
        self.assertTrue(self.provider.is_available)

    def test_extract_stock_code_basic_codes(self) -> None:
        self.assertEqual(
            CninfoSearchProvider._extract_stock_code(
                "贵州茅台 600519 股票 最新消息"
            ),
            "600519",
        )
        self.assertEqual(
            CninfoSearchProvider._extract_stock_code("000001 平安银行公告"),
            "000001",
        )
        self.assertEqual(
            CninfoSearchProvider._extract_stock_code("找下 300750 宁德时代"),
            "300750",
        )

    def test_extract_stock_code_skips_non_a_share(self) -> None:
        # 港股 / 美股不会被匹配
        self.assertIsNone(
            CninfoSearchProvider._extract_stock_code("hk00700 腾讯 latest")
        )
        self.assertIsNone(
            CninfoSearchProvider._extract_stock_code("AAPL Apple stock news")
        )
        # 6 位之外的数字不匹配
        self.assertIsNone(
            CninfoSearchProvider._extract_stock_code("PE 25.3 营收 12345 净利")
        )

    def test_do_search_returns_empty_when_no_stock_code(self) -> None:
        """没有股票代码时不应失败，应静默返回空结果让上层试下一个 provider。"""
        response = self.provider._do_search(
            query="股票市场最新动态",
            api_key="",
            max_results=5,
            days=7,
        )
        self.assertTrue(response.success)
        self.assertEqual(response.results, [])

    def test_do_search_maps_cninfo_payload_to_search_results(self) -> None:
        # 真实 cninfo 接口的字段：announcementTitle / announcementTime(ms) / adjunctUrl / secName
        payload = {
            "announcements": [
                {
                    "secCode": "600519",
                    "secName": "贵州茅台",
                    "announcementTitle": "贵州茅台关于回购股份实施结果暨股份变动的公告",
                    "announcementTime": 1779897600000,  # 2026-05-28 epoch ms
                    "announcementId": "1225333825",
                    "orgId": "gssh0600519",
                    "adjunctUrl": "finalpage/2026-05-28/1225333825.PDF",
                },
                {
                    "secCode": "600519",
                    "secName": "贵州茅台",
                    "announcementTitle": "贵州茅台 2025 年年度报告",
                    "announcementTime": 1779200000000,
                    "announcementId": "1225222000",
                    "orgId": "gssh0600519",
                    "adjunctUrl": "",
                },
            ]
        }

        with patch("src.search_service.requests.post", return_value=_make_response(payload)) as mock_post:
            response = self.provider._do_search(
                query="贵州茅台 600519 股票 最新消息",
                api_key="",
                max_results=5,
                days=30,
            )

        self.assertTrue(response.success)
        self.assertEqual(len(response.results), 2)

        first = response.results[0]
        self.assertEqual(first.title, "贵州茅台关于回购股份实施结果暨股份变动的公告")
        self.assertEqual(first.source, "巨潮资讯")
        # PDF 直链
        self.assertTrue(first.url.startswith("http://static.cninfo.com.cn/finalpage/"))
        # published_date 应是 YYYY-MM-DD
        self.assertRegex(first.published_date or "", r"^\d{4}-\d{2}-\d{2}$")

        # 第二条没有 adjunctUrl，应回落 detail 页
        second = response.results[1]
        self.assertIn("/new/disclosure/detail", second.url)
        self.assertIn("announcementId=1225222000", second.url)

        # 接口入参校验
        mock_post.assert_called_once()
        url, kwargs = mock_post.call_args.args[0], mock_post.call_args.kwargs
        self.assertEqual(url, CninfoSearchProvider._CNINFO_QUERY_URL)
        data = kwargs.get("data", {})
        self.assertEqual(data.get("stock"), "600519,gssh0600519")
        # 600519 走 sse
        self.assertEqual(data.get("column"), "sse")

    def test_do_search_szse_routing(self) -> None:
        """000001 (深圳) 应路由到 column=szse 且 orgId=gssz."""
        with patch(
            "src.search_service.requests.post",
            return_value=_make_response({"announcements": []}),
        ) as mock_post:
            self.provider._do_search(
                query="000001 平安银行",
                api_key="",
                max_results=5,
                days=7,
            )

        data = mock_post.call_args.kwargs.get("data", {})
        self.assertEqual(data.get("column"), "szse")
        self.assertEqual(data.get("stock"), "000001,gssz0000001")

    def test_do_search_caps_max_results(self) -> None:
        payload = {
            "announcements": [
                {
                    "secCode": "600519",
                    "secName": "贵州茅台",
                    "announcementTitle": f"公告 #{i}",
                    "announcementTime": 1779200000000,
                    "announcementId": f"id-{i}",
                    "orgId": "gssh0600519",
                    "adjunctUrl": "",
                }
                for i in range(10)
            ]
        }
        with patch("src.search_service.requests.post", return_value=_make_response(payload)):
            response = self.provider._do_search(
                query="600519 茅台",
                api_key="",
                max_results=3,
                days=30,
            )
        self.assertEqual(len(response.results), 3)

    def test_do_search_handles_http_failure(self) -> None:
        with patch(
            "src.search_service.requests.post",
            side_effect=RuntimeError("network error"),
        ):
            response = self.provider._do_search(
                query="600519 茅台",
                api_key="",
                max_results=5,
                days=7,
            )
        self.assertFalse(response.success)
        self.assertEqual(response.results, [])
        self.assertIn("network error", response.error_message or "")

    def test_do_search_handles_empty_payload(self) -> None:
        with patch(
            "src.search_service.requests.post",
            return_value=_make_response({"announcements": []}),
        ):
            response = self.provider._do_search(
                query="600519 冷门股",
                api_key="",
                max_results=5,
                days=7,
            )
        self.assertTrue(response.success)
        self.assertEqual(response.results, [])


if __name__ == "__main__":
    unittest.main()
