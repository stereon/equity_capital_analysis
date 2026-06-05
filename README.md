# Equity Capital Analysis

一个本地化的个人股票分析 agent，覆盖 A 股 / 港股 / 美股，结合大盘观察、AI 个股分析、候选股推荐、持仓跟踪、告警、回测、每日早盘播报与收盘总结。

后端 FastAPI + SQLite，前端 React 19 + Vite + shadcn/ui，LLM 默认指向本地 Claude CLI（通过一个 OpenAI 兼容 shim 包装），数据源走 Tushare / akshare / yfinance + Tavily 新闻搜索。

---

## 主要能力

| 页面 | 说明 |
|------|------|
| 大盘 | A/H/US 三市指数实时报价、市场统计、板块涨跌排行；按需触发大盘复盘 |
| 早盘播报 / 收盘总结 | 一键生成：早盘汇总隔夜美股 + 港股早盘 + 新闻；收盘总结 A 股 + 港股 + 板块 + 新闻 |
| 候选股推荐 | 基于今日领涨板块 + 技术评分（MA 排列 / 动量 / 量比 / 距 20 日高点）筛选；Top N 用实时报价覆盖 |
| 个股 AI 分析 | 输入代码触发完整 AI 决策报告，支持多策略 skill 叠加；运行中切走再回来自动续轮询 |
| 持仓分析 | 多账户 / 交易记录 / CSV 导入 / 浮盈浮亏 / 多账户汇总 |
| 告警 | 价格、技术指标、组合层面告警规则与触发记录 |
| 回测 | 单策略回测、绩效指标卡、收益曲线 |
| 历史 | 个股 / 大盘 / 早盘 / 收盘 / 荐股 五类报告统一查询，markdown 详情可直接查看 |
| 设置 | schema 驱动的 155 字段配置表单，分 8 大类 |

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | FastAPI、SQLite、SQLAlchemy、APScheduler |
| 前端 | React 19、Vite 6、TypeScript 5.7、Tailwind v4、shadcn/ui (new-york)、TanStack Query 5（含 localStorage 持久化）、React Router 7、echarts |
| LLM | 本地 Claude CLI（默认）经 `scripts/claude_openai_shim.py` 包装成 OpenAI 兼容端点；亦支持远程 OpenAI / Codex / Gemini 等渠道 |
| A 股数据 | Tushare（主）、akshare（备）、efinance（fallback） |
| 港股 / 美股 | yfinance（主）、akshare（备） |
| 新闻 | Tavily（主）、SearXNG（备） |

## 快速开始

### 1. 装依赖

```bash
git clone git@github.com:stereon/equity_capital_analysis.git
cd equity_capital_analysis
pip install -r requirements.txt
```

### 2. 配置 `.env`

```bash
cp .env.example .env
```

至少补齐：
- `TUSHARE_TOKEN` —— Tushare A 股数据源
- LLM 渠道：默认走本地 Claude CLI（需要本机已安装 `claude`），不另配 key 即可
- 自选股 `STOCK_LIST=600519,hk00700,AAPL`

可选增强：
- 新闻 / 公告 / 主力资金等免费数据源接入（巨潮、东财个股新闻、雪球 cookie 等）见 [`docs/data-sources-setup.md`](docs/data-sources-setup.md)
- LLM 渠道详细配置见 [`docs/LLM_CONFIG_GUIDE.md`](docs/LLM_CONFIG_GUIDE.md)

### 3. 启动 LLM shim（仅在用本地 Claude 时需要）

```bash
python scripts/claude_openai_shim.py    # 默认监听 :8766
```

详细说明见 `docs/claude-local-shim.md`。

### 4. 启动后端

```bash
python main.py --serve-only --host 127.0.0.1 --port 8000
```

API 文档 `http://127.0.0.1:8000/docs`。

### 5. 启动前端

```bash
cd web
bun install     # 或 pnpm install / npm install
bun run dev     # http://localhost:5173
```

生产构建：`bun run build`，产物在 `web/dist/`。

## 部署上线

生产部署推荐用 Docker Compose；也提供一键脚本与 systemd 模板：

```bash
docker-compose -f ./docker/docker-compose.yml up -d   # Docker Compose（推荐）
APP_USER=$USER bash scripts/deploy/setup.sh            # 一键脚本：装依赖 / 建 venv / 构建前端 / 启用 systemd
```

完整的方案对比、systemd 服务模板（`scripts/deploy/equilytic.service`）、升级与排障见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 命令行入口

```bash
python main.py --stocks 600519,hk00700,AAPL --no-notify    # 单次分析
python main.py --market-review                              # 大盘复盘
python main.py --debug                                      # 调试模式
python main.py --dry-run                                    # 只演练流程
python main.py --schedule                                   # 启用调度
```

## 项目结构

```
src/             业务核心：core / services / repositories / reports / schemas
data_provider/   多数据源适配 + fallback
api/             FastAPI 路由（含 /api/v1/web/* 给前端用的定制端点）
bot/             机器人接入
scripts/         本地脚本（含 claude/codex shim）
web/             React 前端
tests/           pytest
docs/            模块行为、配置说明、专题文档
```

更细的字段契约、数据源 fallback、报告结构、调度行为等见 `docs/`。

## License

[MIT License](LICENSE)

## 免责声明

本项目仅供个人学习和研究使用，不构成投资建议。股市有风险，投资需谨慎，作者不对使用本项目产生的任何损失负责。
