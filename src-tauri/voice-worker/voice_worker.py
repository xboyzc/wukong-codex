#!/usr/bin/env python3
"""Persistent local Qwen3-TTS voice-cloning worker for Jarvis Codex.

The worker communicates over JSON Lines on stdin/stdout. Model diagnostics are
redirected to stderr so stdout remains a machine-readable IPC channel.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import re
import sys
import time
from pathlib import Path

DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit"
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
    """Turn a display answer into natural spoken text without reading markup."""
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

    # Voice cloning generates the whole waveform before playback. Speaking an
    # entire long task report therefore makes the UI feel frozen. Keep the
    # complete answer on screen, but synthesize only its first useful sentence
    # (or a short clause) and tell the user where the remaining detail is.
    prefix_budget = MAX_SPOKEN_CHARS - len(TRUNCATION_NOTICE) - 2
    sentences = re.findall(r"[^。！？!?；;]+[。！？!?；;]?", text)
    first_sentence = sentences[0].strip() if sentences else text
    selected = first_sentence[:prefix_budget]
    if len(first_sentence) > prefix_budget:
        # Prefer a natural clause boundary over cutting a Chinese word.
        boundary = max(selected.rfind(mark) for mark in "，,、：:")
        if boundary >= 12:
            selected = selected[:boundary]
    selected = re.sub(r"[，,、：:\s]+$", "", selected)
    if selected[-1:] not in "。！？!?；;":
        selected += "。"
    return f"{selected}{TRUNCATION_NOTICE}"


def prune_old_audio(output_dir: Path, keep: int = 16) -> None:
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
    import mlx.core as mx
    import numpy as np
    from mlx_audio.audio_io import write as audio_write
    from mlx_audio.tts.utils import load as load_tts_model
    from mlx_audio.utils import load_audio

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

    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        model = load_tts_model(args.model)
        # Keep both the waveform and the expensive Qwen reference features in
        # memory. Qwen's own ICL cache reuses codec tokens; the small wrapper
        # below also reuses the speaker embedding instead of recomputing it for
        # every short streaming phrase.
        reference_audio_samples = load_audio(
            str(reference_audio), sample_rate=int(model.sample_rate)
        )
        mx.eval(reference_audio_samples)
        cached_speaker_embedding = model.extract_speaker_embedding(
            reference_audio_samples
        )
        mx.eval(cached_speaker_embedding)
        model.extract_speaker_embedding = (
            lambda _audio, sr=24000: cached_speaker_embedding
        )
        warm_inputs = model._prepare_icl_generation_inputs(
            "准备就绪。",
            ref_audio=reference_audio_samples,
            ref_text=reference_text,
            language="Chinese",
        )
        mx.eval(*warm_inputs)
    emit(
        {
            "type": "ready",
            "model": args.model,
            "loadMs": round((time.perf_counter() - started) * 1000),
            "referenceCached": True,
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
            audio_chunks: list[np.ndarray] = []
            sample_rate = 0
            # Qwen's decoder yields 0.8-second waveform pieces. Keep generation
            # incremental, but join those pieces before playback: starting a
            # new macOS player for every tiny file creates audible gaps.
            results = model.generate(
                text=speech_text,
                lang_code="Chinese",
                ref_audio=reference_audio_samples,
                ref_text=reference_text,
                temperature=0.2,
                repetition_penalty=1.05,
                max_tokens=4096,
                verbose=False,
                stream=True,
                streaming_interval=0.8,
            )
            while True:
                # The model may print diagnostics while advancing its generator;
                # redirect only that step. Chunk IPC must remain on stdout.
                try:
                    with contextlib.redirect_stdout(sys.stderr):
                        result = next(results)
                except StopIteration:
                    break
                audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                if audio.size == 0:
                    continue
                result_sample_rate = int(result.sample_rate)
                if sample_rate and result_sample_rate != sample_rate:
                    raise RuntimeError("voice model changed sample rate mid-sentence")
                sample_rate = result_sample_rate
                audio_chunks.append(audio)
            if not audio_chunks or not sample_rate:
                raise RuntimeError("voice model returned no audio")
            audio = np.concatenate(audio_chunks)
            total_duration_ms = round(len(audio) / sample_rate * 1000)
            output_path = output_dir / (
                f"jarvis-cloned-voice-{request_id}-0-{time.time_ns()}.wav"
            )
            audio_write(output_path, audio, sample_rate, format="wav")
            generation_ms = round(
                (time.perf_counter() - generation_started) * 1000
            )
            emit(
                {
                    "type": "chunk",
                    "id": request_id,
                    "path": str(output_path),
                    "durationMs": total_duration_ms,
                    "generationMs": generation_ms,
                    "chunkIndex": 0,
                }
            )
            prune_old_audio(output_dir, keep=32)
            emit(
                {
                    "type": "result",
                    "id": request_id,
                    "chunkCount": 1,
                    "durationMs": total_duration_ms,
                    "generationMs": generation_ms,
                    "text": speech_text,
                }
            )
        except Exception as error:  # Keep the warm model alive after bad input.
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
