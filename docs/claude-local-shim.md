# 本地 Claude Shim 实验说明

`scripts/claude_openai_shim.py` 可以把本机 `claude -p`（Claude Code CLI）包装成一个最小 OpenAI-compatible Chat Completions 服务，供本项目的 LiteLLM 配置调用。适合在没有可用模型 API Key、但本地已登录 Claude 订阅时做纯文本分析实验。

## 适用范围

- 适合本地实验纯文本股票分析报告。
- 不适合作为生产模型服务。
- 不支持 OpenAI `tool_calls` 协议；Agent 问股里的工具调用链可能无法完整工作。
- `stream=true` 会返回 SSE 格式，但实际内容是在 `claude -p` 完成后再分块发送，不是真正边生成边返回。
- 每次请求都会启动新的 Claude CLI 进程，单次调用延迟通常在数十秒级别，明显高于 Ollama / LM Studio。
- 鉴权沿用本机 `claude` CLI 已有方式（订阅登录或 `ANTHROPIC_API_KEY`），无需额外配置 Key。

## 启动 Shim

```bash
cd /path/to/equity_capital_analysis
python scripts/claude_openai_shim.py --host 127.0.0.1 --port 8766
```

如需指定模型（默认沿用 CLI 当前模型）：

```bash
CLAUDE_SHIM_MODEL=sonnet python scripts/claude_openai_shim.py --port 8766
```

可选环境变量：

```bash
CLAUDE_SHIM_CLAUDE_BIN=claude            # claude 可执行文件路径
CLAUDE_SHIM_MODEL=sonnet                 # 传给 --model，留空用 CLI 默认
CLAUDE_SHIM_TIMEOUT_SECONDS=900          # 单次调用超时
CLAUDE_SHIM_WORKDIR=/tmp                 # 运行目录，默认临时目录，避免加载本仓库 CLAUDE.md/hooks
CLAUDE_SHIM_EXTRA_ARGS='--no-session-persistence'
```

## 配置项目

在 `.env` 中配置：

```bash
LLM_CHANNELS=claude_local
LLM_CLAUDE_LOCAL_PROTOCOL=openai
LLM_CLAUDE_LOCAL_BASE_URL=http://127.0.0.1:8766/v1
LLM_CLAUDE_LOCAL_API_KEY=dummy-local-key
LLM_CLAUDE_LOCAL_MODELS=claude-local
LITELLM_MODEL=openai/claude-local
```

建议本地先关闭通知并指定少量股票测试：

```bash
python main.py --stocks 600519,AAPL --no-notify
```

## 自检

```bash
curl -sS http://127.0.0.1:8766/v1/models
```

```bash
curl -sS -X POST http://127.0.0.1:8766/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-local","messages":[{"role":"user","content":"只回复 ok"}]}'
```

如果 Claude CLI 本身无法在当前终端运行（未登录、额度不足等），shim 会返回 5xx JSON 错误，并带上 `claude -p` 的 stderr/stdout 尾部。
