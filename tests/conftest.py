# -*- coding: utf-8 -*-
"""Pytest 全局 conftest.

约束：仓库的 .env 通过 src.config.get_config -> load_dotenv 被反复加载，会把
开发环境的可选开关注入到测试进程的 os.environ，导致依赖 provider 列表的测试
受真实配置干扰。

策略：autouse fixture 在每个测试前剔除这些 toggles；如果某个测试需要主动启
用，应在该测试内显式设置 os.environ。
"""
import os

import pytest


# 测试期间默认 OFF 的开关：开了会改变默认 provider 列表 / 数据源行为。
_PROD_ONLY_TOGGLES = (
    "CNINFO_DISCLOSURE_ENABLED",
    "EM_STOCK_NEWS_ENABLED",
    "DATA_SOURCE_DISABLE_EFINANCE",
)


@pytest.fixture(autouse=True)
def _isolate_prod_env_toggles():
    """每个测试前清空生产专用 env 开关，测试结束后恢复原值。"""
    saved = {k: os.environ.pop(k, None) for k in _PROD_ONLY_TOGGLES}
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)
