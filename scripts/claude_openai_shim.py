#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Expose the local Claude Code CLI as a minimal OpenAI-compatible chat endpoint.

This is a personal/local experiment helper. It is good enough for plain text
stock-analysis report generation, but it is not a full model server:

- OpenAI tool_calls are not supported.
- Streaming responses are SSE-compatible, but chunks are emitted after the
  Claude CLI command has completed.
- Each request starts a fresh `claude -p` process, so latency and token usage
  are much higher than a real local model server such as Ollama.
- Auth follows whatever the local Claude CLI already uses (subscription login
  / ANTHROPIC_API_KEY), so no extra key is needed when you are logged in.

Usage:
    python scripts/claude_openai_shim.py --host 127.0.0.1 --port 8766

Then configure the app:
    LLM_CHANNELS=claude_local
    LLM_CLAUDE_LOCAL_PROTOCOL=openai
    LLM_CLAUDE_LOCAL_BASE_URL=http://127.0.0.1:8766/v1
    LLM_CLAUDE_LOCAL_API_KEY=dummy-local-key
    LLM_CLAUDE_LOCAL_MODELS=claude-local
    LITELLM_MODEL=openai/claude-local

Optional environment variables:
    CLAUDE_SHIM_CLAUDE_BIN=claude
    CLAUDE_SHIM_MODEL=sonnet
    CLAUDE_SHIM_TIMEOUT_SECONDS=900
    CLAUDE_SHIM_WORKDIR=/path/to/neutral/dir
    CLAUDE_SHIM_EXTRA_ARGS='--no-session-persistence'
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


SERVER_NAME = "claude-openai-shim"
DEFAULT_MODEL_ID = "claude-local"
DEFAULT_PORT = 8766
MAX_ERROR_TEXT = 4000


class ClaudeShimError(RuntimeError):
    """Raised when the local Claude command cannot produce a response."""

    def __init__(self, message: str, *, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code


def _json_bytes(payload: Dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _now() -> int:
    return int(time.time())


def _content_to_text(content: Any) -> str:
    """Convert OpenAI-compatible message content into plain text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue
            if not isinstance(item, dict):
                parts.append(str(item))
                continue
            item_type = item.get("type")
            if item_type == "text":
                parts.append(str(item.get("text") or ""))
            elif item_type == "image_url":
                parts.append("[image_url omitted by claude shim]")
            else:
                text = item.get("text") or item.get("content")
                if text:
                    parts.append(str(text))
        return "\n".join(part for part in parts if part)
    if isinstance(content, dict):
        text = content.get("text") or content.get("content")
        if text is not None:
            return str(text)
    return str(content)


def _messages_to_prompt(payload: Dict[str, Any]) -> str:
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ClaudeShimError("Request body must include a non-empty messages list", status_code=400)

    parts: List[str] = [
        "You are being used as a local text-completion backend for another application.",
        "Do not edit files, run shell commands, ask follow-up questions, or mention this shim.",
        "Return only the answer content requested by the conversation below.",
    ]

    response_format = payload.get("response_format")
    if isinstance(response_format, dict) and response_format.get("type") in {"json_object", "json_schema"}:
        parts.append("The caller requested JSON output. Return valid JSON only, with no Markdown fences.")

    tools = payload.get("tools")
    if tools:
        parts.append(
            "Compatibility note: the caller included tool definitions, but this Claude shim cannot "
            "return OpenAI tool_calls. Provide the best final answer directly from the supplied context."
        )

    parts.append("\n--- conversation ---")
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "user")
        name = message.get("name")
        label = role if not name else f"{role} ({name})"
        content = _content_to_text(message.get("content")).strip()
        tool_calls = message.get("tool_calls")
        if tool_calls:
            content = f"{content}\n[tool_calls]\n{json.dumps(tool_calls, ensure_ascii=False)}".strip()
        parts.append(f"\n[{label}]\n{content}")

    parts.append("\n--- response ---")
    return "\n".join(parts).strip()


def _tail(text: str, limit: int = MAX_ERROR_TEXT) -> str:
    if len(text) <= limit:
        return text
    return text[-limit:]


def _claude_command() -> Tuple[List[str], Path, int]:
    claude_bin = os.environ.get("CLAUDE_SHIM_CLAUDE_BIN", "claude").strip() or "claude"
    model = os.environ.get("CLAUDE_SHIM_MODEL", "").strip()
    timeout = int(os.environ.get("CLAUDE_SHIM_TIMEOUT_SECONDS", "900"))
    workdir = Path(os.environ.get("CLAUDE_SHIM_WORKDIR", tempfile.gettempdir())).resolve()
    extra_args = shlex.split(os.environ.get("CLAUDE_SHIM_EXTRA_ARGS", ""))

    cmd = [claude_bin, "-p", "--output-format", "text"]
    if model:
        cmd.extend(["--model", model])
    cmd.extend(extra_args)
    return cmd, workdir, timeout


def run_claude(prompt: str) -> str:
    cmd, workdir, timeout = _claude_command()
    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            text=True,
            capture_output=True,
            cwd=str(workdir),
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ClaudeShimError(f"claude -p timed out after {timeout}s", status_code=504) from exc
    except OSError as exc:
        raise ClaudeShimError(f"failed to start claude -p: {exc}", status_code=500) from exc

    text = (proc.stdout or "").strip()

    if proc.returncode != 0:
        detail = "\n".join(
            part
            for part in (
                f"claude -p exited with status {proc.returncode}",
                _tail(proc.stderr.strip()),
                _tail(text),
            )
            if part
        )
        raise ClaudeShimError(detail, status_code=502)

    if not text:
        raise ClaudeShimError("claude -p returned an empty response", status_code=502)
    return text


def _completion_payload(model: str, text: str, request_id: str) -> Dict[str, Any]:
    return {
        "id": request_id,
        "object": "chat.completion",
        "created": _now(),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }


def _stream_chunks(model: str, text: str, request_id: str, chunk_size: int = 1200) -> Iterable[Dict[str, Any]]:
    created = _now()
    yield {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
    }
    for start in range(0, len(text), chunk_size):
        yield {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": text[start:start + chunk_size]},
                    "finish_reason": None,
                }
            ],
        }
    yield {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }


class ClaudeOpenAIHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = SERVER_NAME

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(f"[{SERVER_NAME}] {self.address_string()} - {fmt % args}\n")

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status: int, message: str, error_type: str = "claude_shim_error") -> None:
        self._send_json(status, {"error": {"message": message, "type": error_type, "code": status}})

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            raise ClaudeShimError("Empty request body", status_code=400)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ClaudeShimError(f"Invalid JSON request body: {exc}", status_code=400) from exc
        if not isinstance(payload, dict):
            raise ClaudeShimError("Request body must be a JSON object", status_code=400)
        return payload

    def do_GET(self) -> None:
        if self.path in {"/health", "/v1/health"}:
            self._send_json(200, {"status": "ok", "server": SERVER_NAME})
            return
        if self.path == "/v1/models":
            model_id = os.environ.get("CLAUDE_SHIM_OPENAI_MODEL_ID", DEFAULT_MODEL_ID)
            self._send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": model_id,
                            "object": "model",
                            "created": _now(),
                            "owned_by": "claude-local",
                        }
                    ],
                },
            )
            return
        self._send_error_json(404, f"Not found: {self.path}", "not_found")

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self._send_error_json(404, f"Not found: {self.path}", "not_found")
            return

        try:
            payload = self._read_json_body()
            model = str(payload.get("model") or os.environ.get("CLAUDE_SHIM_OPENAI_MODEL_ID") or DEFAULT_MODEL_ID)
            request_id = f"chatcmpl-claude-{uuid.uuid4().hex}"
            prompt = _messages_to_prompt(payload)
            text = run_claude(prompt)
            if payload.get("stream"):
                self._send_stream(model, text, request_id)
            else:
                self._send_json(200, _completion_payload(model, text, request_id))
        except ClaudeShimError as exc:
            self._send_error_json(exc.status_code, str(exc))
        except Exception as exc:  # pragma: no cover - defensive server boundary
            self._send_error_json(500, f"Unexpected shim error: {exc}")

    def _send_stream(self, model: str, text: str, request_id: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for chunk in _stream_chunks(model, text, request_id):
            line = f"data: {json.dumps(chunk, ensure_ascii=False, separators=(',', ':'))}\n\n"
            self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local OpenAI-compatible shim backed by the Claude CLI.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Defaults to 127.0.0.1.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Bind port. Defaults to {DEFAULT_PORT}.")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    server = ThreadingHTTPServer((args.host, args.port), ClaudeOpenAIHandler)
    print(f"{SERVER_NAME} listening on http://{args.host}:{args.port}/v1")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
