# 数据源配置（.env）

本文档讲怎么配 `.env`，让本系统在不同网络环境下都能拿到尽量完整的 A 股 / 港股 / 美股数据。LLM 渠道（`LITELLM_*` / `LLM_CHANNELS`）走另一篇 [LLM_CONFIG_GUIDE.md](LLM_CONFIG_GUIDE.md)，这里不重复。

---

## 必需配置

| 变量 | 作用 | 不配的后果 |
|---|---|---|
| `TUSHARE_TOKEN` | A 股 daily / cyq_chips / moneyflow_ind_ths 等核心接口 | A 股日线降级到 akshare-sina，速度变慢、字段不全 |
| `STOCK_LIST` | 自选股列表，逗号分隔 | 部分页面（候选股推荐、自选 watchlist）没有数据 |

最简 `.env`：

```ini
LITELLM_MODEL=openai/claude-local  # 或别的 LLM 渠道，详见 LLM_CONFIG_GUIDE.md
TUSHARE_TOKEN=你的 token
STOCK_LIST=600519,hk00700,AAPL
```

Tushare 免费等级（120 积分）能跑通主流程；`trade_cal` 走的是本地 `exchange_calendars` 推算，不会触发免费版 5 次/天限频。

---

## 可选数据源开关

下列开关都默认 **OFF**，按需在 `.env` 启用。

### `DATA_SOURCE_DISABLE_EFINANCE`（默认 `false`）

```ini
DATA_SOURCE_DISABLE_EFINANCE=true
```

efinance 完全依赖 `push2.eastmoney.com`。如果这个域名在你的网络下被阻断（如企业内网），efinance 每次调用都会失败 + 4 次 retry，刷满日志噪音。启用此开关把 efinance 从 fetcher 链里剔除，让其他源（Tushare / akshare-sina / yfinance）直接接力。

判定方式：

```bash
curl -sS -m 5 "http://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1&fs=m:1+t:2&fields=f12"
# 返回 'Empty reply from server' 或超时 → 阻断，建议启用
```

> `quote.eastmoney.com` / `data.eastmoney.com` / `datacenter-web.eastmoney.com` 不受此开关影响，akshare 走这些子域的接口（涨停池、龙虎榜、人气榜等）仍然工作。

### `CNINFO_DISCLOSURE_ENABLED`（默认 `false`）

```ini
CNINFO_DISCLOSURE_ENABLED=true
```

启用巨潮资讯网公告搜索作为 SearchService 兜底。仅对 A 股有效（query 中识别到 6 位股票代码才触发）。无需 API Key，直连巨潮 hisAnnouncement HTTP 接口。适合没有 Tavily / SerpAPI 等付费搜索 key、但仍想给 AI 喂"消息面"输入的场景。

### `EM_STOCK_NEWS_ENABLED`（默认 `false`）

```ini
EM_STOCK_NEWS_ENABLED=true
```

启用东方财富个股新闻搜索（经 akshare `stock_news_em`，走 `search-api-web.eastmoney.com`，不是被阻断的 push2）。和 `CNINFO_DISCLOSURE_ENABLED` 互补：cninfo 是法定公告，em 是市场新闻 / 资讯 / 题材快讯。

### `SEARXNG_PUBLIC_INSTANCES_ENABLED`（默认 `true`）

```ini
SEARXNG_PUBLIC_INSTANCES_ENABLED=false
```

公共 SearXNG 实例当前几乎全部返回 429 限流，触发的 WARNING 噪音很大。无自建 SearXNG 实例时建议关闭。有自建实例时设 `SEARXNG_BASE_URLS=https://...,https://...` 并把这一项保持 `true`。

---

## 雪球 Cookie（个股资金流）

被阻断 push2 之后，"主力净流入"这个维度的免费替代来自雪球登录态 API。配置后，`fundamental_adapter.get_capital_flow` 会优先走 `https://stock.xueqiu.com/v5/stock/capital/history.json` 拿当日 / 5 日 / 10 日累计主力净额。

### 取 cookie 步骤

1. 浏览器打开 [https://xueqiu.com](https://xueqiu.com) 并登录账号
2. 任意打开一只股票详情页（如 https://xueqiu.com/S/SH600519）
3. F12 → Network 标签 → 刷新页面
4. 点击任意一个 `xueqiu.com` 的 XHR 请求 → Headers → 拉到 Request Headers
5. 复制完整的 `Cookie:` 头值

写到 `.env`：

```ini
XUEQIU_COOKIE=acw_tc=...; cookiesu=...; device_id=...; xq_a_token=...; xqat=...; xq_r_token=...; xq_is_login=1; u=...; is_overseas=0
```

### 关键字段（最少保留）

```
xq_a_token   # 主认证 token
xqat         # 备份认证
xq_r_token   # refresh token
u            # 用户 uid
xq_is_login  # 登录态标记
cookiesu     # 雪球内部 session id
device_id    # 设备指纹
acw_tc       # 阿里云 WAF token
```

去掉营销追踪类（`Hm_*`、`ssxmod_*`、`HMACCOUNT`、`thumbcache_*` 等）不影响接口。

### 过期与续期

雪球 `xq_id_token` 的 JWT 中 `exp` 约为签发后 30 天。过期后接口返回 `error_code=400016` "请重新登录"。这时 `fundamental_adapter` 会进入 5 分钟失败冷却避免雪崩；需要手动重新登录 + 复制 cookie 覆盖 `.env` 的 `XUEQIU_COOKIE`，再重启服务。

> ⚠️ cookie 是身份凭证，**不要提交到 git**。`.env` 已经在仓库 `.gitignore` 里。

---

## 时效窗口 / 性能调优

| 变量 | 默认 | 说明 |
|---|---|---|
| `NEWS_MAX_AGE_DAYS` | `3` | 新闻最大时效（天）。跨周末看周一时建议调到 `7`，避免 Friday 的快讯被卡掉 |
| `NEWS_STRATEGY_PROFILE` | `short` | 新闻窗口策略档位：`ultra_short=1` / `short=3` / `medium=7` / `long=30`。和 `NEWS_MAX_AGE_DAYS` 取最小生效 |
| `FUNDAMENTAL_FETCH_TIMEOUT_SECONDS` | `3.0` | 单个 fundamental block 的 fetch 超时。配了雪球资金流时建议 `5`，给跨网络请求余量 |
| `FUNDAMENTAL_STAGE_TIMEOUT_SECONDS` | `8.0` | 所有 fundamental block 共享的总预算。默认 8s 容易让最后几块（capital_flow / dragon_tiger）耗尽，建议 `15` |

---

## 完整 `.env` 示例

```ini
# === LLM ===
LITELLM_MODEL=openai/claude-local
LLM_CHANNELS=claude_local
LLM_CLAUDE_LOCAL_PROTOCOL=openai
LLM_CLAUDE_LOCAL_BASE_URL=http://127.0.0.1:8766/v1
LLM_CLAUDE_LOCAL_API_KEY=dummy-local-key
LLM_CLAUDE_LOCAL_MODELS=claude-local

# === A 股数据 ===
TUSHARE_TOKEN=你的_tushare_token
STOCK_LIST=600519,hk00700,AAPL

# === 受限网络优化 ===
DATA_SOURCE_DISABLE_EFINANCE=true
SEARXNG_PUBLIC_INSTANCES_ENABLED=false

# === 免费新闻 / 公告兜底 ===
CNINFO_DISCLOSURE_ENABLED=true
EM_STOCK_NEWS_ENABLED=true
NEWS_MAX_AGE_DAYS=7
NEWS_STRATEGY_PROFILE=medium

# === 雪球（个股资金流，30 天过期需续）===
XUEQIU_COOKIE=acw_tc=...; cookiesu=...; xq_a_token=...; xqat=...; xq_r_token=...; xq_is_login=1; u=...; is_overseas=0

# === Fundamental fetch 预算（配了雪球后调大）===
FUNDAMENTAL_FETCH_TIMEOUT_SECONDS=5
FUNDAMENTAL_STAGE_TIMEOUT_SECONDS=15
```

---

## 排障

### `[Tushare] 未获取到指数行情数据`
免费版 `index_daily` 无权限。akshare-sina 会自动接力，dashboard 仍能完整展示 6 个 A 股指数。

### `cninfo 查询失败: ...`
巨潮接口被反爬挡回或 timeout。无关紧要，单次失败下次会再试；可临时设 `CNINFO_DISCLOSURE_ENABLED=false` 跳过。

### `[Xueqiu] capital/history 失败，进入冷却`
cookie 过期或本次请求被风控。5 分钟内不会再打雪球，自动回退到 akshare 候选链。重新登录雪球更新 cookie 即可恢复。

### dashboard 卡在转圈
检查 `Tushare` 是否触发限频，必要时增大 `FUNDAMENTAL_STAGE_TIMEOUT_SECONDS` 或缩短 dashboard 60s 缓存。
