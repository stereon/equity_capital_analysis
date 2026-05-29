# 本地 Codex Shim 实验说明

`scripts/codex_openai_shim.py` 可以把本机 `codex exec` 包装成一个最小 OpenAI-compatible Chat Completions 服务，供本项目的 LiteLLM 配置调用。

## 适用范围

- 适合本地实验纯文本股票分析报告。
- 不适合作为生产模型服务。
- 不支持 OpenAI `tool_calls` 协议；Agent 问股里的工具调用链可能无法完整工作。
- `stream=true` 会返回 SSE 格式，但实际内容是在 `codex exec` 完成后再分块发送，不是真正边生成边返回。
- 每次请求都会启动新的 Codex CLI 进程，延迟和 token 消耗通常高于 Ollama / LM Studio。

## 启动 Shim

```bash
cd /path/to/daily_stock_analysis
python scripts/codex_openai_shim.py --host 127.0.0.1 --port 8765
```

默认会以低 reasoning effort 调用 Codex：

```bash
CODEX_SHIM_REASONING_EFFORT=low
```

如需指定 Codex 模型：

```bash
CODEX_SHIM_CODEX_MODEL=gpt-5.5 python scripts/codex_openai_shim.py --port 8765
```

## 配置项目

在 `.env` 中配置：

```bash
LLM_CHANNELS=codex_local
LLM_CODEX_LOCAL_PROTOCOL=openai
LLM_CODEX_LOCAL_BASE_URL=http://127.0.0.1:8765/v1
LLM_CODEX_LOCAL_API_KEY=dummy-local-key
LLM_CODEX_LOCAL_MODELS=codex-local
LITELLM_MODEL=openai/codex-local
```

建议本地先关闭通知并指定少量股票测试：

```bash
python main.py --stocks 600519,AAPL --no-notify
```

## 自检

```bash
curl -sS http://127.0.0.1:8765/v1/models
```

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex-local","messages":[{"role":"user","content":"只回复 ok"}]}'
```

如果 Codex CLI 本身无法在当前终端运行，shim 会返回 5xx JSON 错误，并带上 `codex exec` 的 stderr/stdout 尾部。
