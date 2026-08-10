#!/usr/bin/env python3
"""Persistent local Qwen chat worker for Wukong Codex fallback dialogue."""

from __future__ import annotations

import argparse
import json
import sys
import time


DEFAULT_MODEL = "Qwen/Qwen3-1.7B-MLX-4bit"
SYSTEM_PROMPT = (
    "你是用户电脑里的黑悟空智能助手。"
    "请直接用自然、简短、友好的中文回答，通常不超过三句话。"
    "不要输出思考过程，不要使用Markdown，不要假装联网，不要编造事实。"
    "如果问题需要联网、执行电脑操作或你不确定，就明确说明本地模式的边界。"
)


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def clean_reply(value: str) -> str:
    text = value.replace("<think>", "").replace("</think>", "").strip()
    if not text:
        return "我在，但这次本地回答没有生成成功。你可以换一种说法再问我。"
    return text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    try:
        from mlx_lm import generate, load

        model, tokenizer = load(args.model)
    except Exception as error:
        emit({"type": "error", "message": f"本地对话模型初始化失败：{error}"})
        return 2

    history: list[dict[str, str]] = []
    emit({"type": "ready", "model": args.model})

    for raw in sys.stdin:
        request: dict = {}
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            request_type = request.get("type")
            if request_type == "reset":
                history.clear()
                emit({"id": request_id, "type": "reset"})
                continue
            if request_type != "chat":
                raise ValueError("unsupported local chat request")
            text = str(request.get("text", "")).strip()
            if not text:
                raise ValueError("本地对话文本不能为空")

            messages = [{"role": "system", "content": SYSTEM_PROMPT}]
            messages.extend(history[-8:])
            messages.append({"role": "user", "content": text})
            prompt = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            # This official MLX tokenizer does not inject Qwen3's no-thinking
            # marker itself. Supplying the completed block avoids spending the
            # user's latency and speech budget on hidden chain-of-thought.
            prompt += "<think>\n\n</think>\n\n"
            started = time.perf_counter()
            reply = clean_reply(
                generate(
                    model,
                    tokenizer,
                    prompt=prompt,
                    max_tokens=112,
                    verbose=False,
                )
            )
            history.extend(
                [
                    {"role": "user", "content": text},
                    {"role": "assistant", "content": reply},
                ]
            )
            emit(
                {
                    "id": request_id,
                    "type": "reply",
                    "text": reply,
                    "generationMs": round((time.perf_counter() - started) * 1000),
                }
            )
        except Exception as error:
            emit(
                {
                    "id": request.get("id"),
                    "type": "error",
                    "message": str(error),
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
