#!/usr/bin/env python3
"""Persistent Windows Qwen3-TTS worker for the user's authorized voice.

The protocol intentionally matches the macOS MLX worker: JSON Lines on
stdin/stdout, with human-readable diagnostics sent to stderr.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import re
import sys
import time
from pathlib import Path

DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MAX_SPOKEN_CHARS = 64
TRUNCATION_NOTICE = "详细内容已显示在屏幕上。"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--reference-audio", required=True)
    parser.add_argument("--reference-text", required=True)
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args()


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def clean_for_speech(text: str) -> str:
    text = re.sub(r"```[\s\S]*?```", " 代码内容已显示在屏幕上。 ", text)
    text = re.sub(r"!\[([^]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"https?://\S+", "链接已显示在屏幕上", text)
    text = re.sub(r"[`*_>#|]", "", text)
    text = re.sub(r"^\s*[-+•]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+[.)、]\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= MAX_SPOKEN_CHARS:
        return text
    prefix_budget = MAX_SPOKEN_CHARS - len(TRUNCATION_NOTICE) - 2
    sentences = re.findall(r"[^。！？!?;；]+[。！？!?;；]?", text)
    first = sentences[0].strip() if sentences else text
    selected = first[:prefix_budget]
    if len(first) > prefix_budget:
        boundary = max((selected.rfind(mark) for mark in "，,、：:"), default=-1)
        if boundary >= 12:
            selected = selected[:boundary]
    selected = re.sub(r"[，,、：:\s]+$", "", selected)
    if selected[-1:] not in "。！？!?;":
        selected += "。"
    return f"{selected}{TRUNCATION_NOTICE}"


def prune_old_audio(output_dir: Path, keep: int = 32) -> None:
    files = sorted(
        output_dir.glob("jarvis-cloned-voice-*.wav"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in files[keep:]:
        try:
            path.unlink()
        except OSError:
            pass


def main() -> int:
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    args = parse_args()
    reference_audio = Path(args.reference_audio).resolve()
    reference_text_path = Path(args.reference_text).resolve()
    output_dir = Path(args.output_dir).resolve()
    if not reference_audio.is_file():
        raise FileNotFoundError(f"reference audio not found: {reference_audio}")
    if not reference_text_path.is_file():
        raise FileNotFoundError(f"reference text not found: {reference_text_path}")
    output_dir.mkdir(parents=True, exist_ok=True)
    reference_text = reference_text_path.read_text(encoding="utf-8").strip()

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        model = Qwen3TTSModel.from_pretrained(
            args.model,
            device_map=device,
            dtype=dtype,
            attn_implementation="sdpa",
        )
    emit(
        {
            "type": "ready",
            "model": args.model,
            "loadMs": round((time.perf_counter() - started) * 1000),
            "referenceCached": False,
            "device": device,
        }
    )

    for line in sys.stdin:
        request: dict[str, object] = {}
        try:
            request = json.loads(line)
            request_id = int(request["id"])
            if request.get("type") == "stop":
                emit({"type": "stopped", "id": request_id})
                return 0
            if request.get("type") != "synthesize":
                raise ValueError("unsupported request type")
            speech_text = clean_for_speech(str(request.get("text", "")))
            if not speech_text:
                raise ValueError("speech text is empty")

            generation_started = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):
                wavs, sample_rate = model.generate_voice_clone(
                    text=speech_text,
                    language="Chinese",
                    ref_audio=str(reference_audio),
                    ref_text=reference_text,
                )
            audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            if audio.size == 0 or int(sample_rate) <= 0:
                raise RuntimeError("voice model returned no audio")
            duration_ms = round(audio.size / int(sample_rate) * 1000)
            output_path = output_dir / (
                f"jarvis-cloned-voice-{request_id}-0-{time.time_ns()}.wav"
            )
            sf.write(output_path, audio, int(sample_rate), subtype="PCM_16")
            generation_ms = round((time.perf_counter() - generation_started) * 1000)
            emit(
                {
                    "type": "chunk",
                    "id": request_id,
                    "path": str(output_path),
                    "durationMs": duration_ms,
                    "generationMs": generation_ms,
                    "chunkIndex": 0,
                }
            )
            prune_old_audio(output_dir)
            emit(
                {
                    "type": "result",
                    "id": request_id,
                    "chunkCount": 1,
                    "durationMs": duration_ms,
                    "generationMs": generation_ms,
                    "text": speech_text,
                }
            )
        except Exception as error:
            emit(
                {
                    "type": "error",
                    "id": request.get("id"),
                    "message": str(error),
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
