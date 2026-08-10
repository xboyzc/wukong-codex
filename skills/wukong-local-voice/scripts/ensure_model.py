#!/usr/bin/env python3
"""Check or download the platform-specific Wukong Qwen3-TTS model."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path


MODELS = {
    "macos": {
        "id": "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit",
        "approxBytes": 1_711_362_048,
        "displaySize": "about 1.71 GB",
    },
    "windows": {
        "id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        "approxBytes": 2_520_000_000,
        "displaySize": "about 2.52 GB",
    },
}

REQUIRED_FILES = (
    "config.json",
    "model.safetensors",
    "speech_tokenizer/model.safetensors",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true")
    action.add_argument("--download", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--platform", choices=("auto", "macos", "windows"), default="auto"
    )
    parser.add_argument("--cache-dir", type=Path)
    return parser.parse_args()


def platform_name(requested: str) -> str:
    if requested != "auto":
        return requested
    if sys.platform == "darwin":
        return "macos"
    if sys.platform == "win32":
        return "windows"
    raise RuntimeError("Wukong Local Voice currently supports macOS and Windows only")


def cache_root(override: Path | None) -> Path:
    if override is not None:
        return override.expanduser().resolve()
    configured = os.environ.get("HF_HUB_CACHE") or os.environ.get(
        "HUGGINGFACE_HUB_CACHE"
    )
    if configured:
        return Path(configured).expanduser().resolve()
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return Path(hf_home).expanduser().resolve() / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def repo_cache_name(model_id: str) -> str:
    return "models--" + model_id.replace("/", "--")


def complete_snapshot(root: Path, model_id: str) -> Path | None:
    snapshots = root / repo_cache_name(model_id) / "snapshots"
    if not snapshots.is_dir():
        return None
    for snapshot in sorted(snapshots.iterdir(), reverse=True):
        if snapshot.is_dir() and all((snapshot / name).is_file() for name in REQUIRED_FILES):
            return snapshot.resolve()
    return None


def python_candidates(platform: str) -> list[Path]:
    candidates = [Path(sys.executable)]
    if configured := os.environ.get("WUKONG_VOICE_PYTHON"):
        candidates.insert(0, Path(configured).expanduser())

    skill_file = Path(__file__).resolve()
    if len(skill_file.parents) > 3:
        repository = skill_file.parents[3]
        candidates.extend(
            [
                repository / ".venv-voice" / "bin" / "python",
                repository / ".venv-voice" / "Scripts" / "python.exe",
            ]
        )

    if platform == "macos":
        candidates.extend(
            [
                Path(
                    "/Applications/Wukong Codex.app/Contents/Resources/voice-runtime/bin/python3"
                ),
                Path.home()
                / "Library/Application Support/Wukong Codex/voice-runtime/bin/python",
            ]
        )
    else:
        roots = [
            Path(os.environ.get("LOCALAPPDATA", "")),
            Path(os.environ.get("ProgramFiles", "")),
        ]
        relative_paths = (
            "Wukong Codex/voice-runtime/python.exe",
            "Programs/Wukong Codex/resources/voice-runtime/python.exe",
            "Wukong Codex/resources/voice-runtime/python.exe",
        )
        for root in roots:
            if str(root) not in ("", "."):
                candidates.extend(root / path for path in relative_paths)

    unique: list[Path] = []
    for candidate in candidates:
        resolved = candidate.expanduser()
        if resolved not in unique:
            unique.append(resolved)
    return unique


def supports_huggingface_hub(python: Path) -> bool:
    if not python.is_file():
        return False
    if python.resolve() == Path(sys.executable).resolve():
        return importlib.util.find_spec("huggingface_hub") is not None
    result = subprocess.run(
        [str(python), "-c", "import huggingface_hub"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=30,
    )
    return result.returncode == 0


def find_download_python(platform: str) -> Path | None:
    for candidate in python_candidates(platform):
        if supports_huggingface_hub(candidate):
            return candidate
    return None


def status_payload(platform: str, root: Path) -> dict[str, object]:
    info = MODELS[platform]
    snapshot = complete_snapshot(root, str(info["id"]))
    return {
        "platform": platform,
        "modelId": info["id"],
        "displaySize": info["displaySize"],
        "approxBytes": info["approxBytes"],
        "cacheDir": str(root),
        "ready": snapshot is not None,
        "downloadRequired": snapshot is None,
        "snapshot": str(snapshot) if snapshot else None,
    }


def download_model(platform: str, root: Path, dry_run: bool) -> int:
    info = MODELS[platform]
    payload = status_payload(platform, root)
    if payload["ready"]:
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    print(
        "提醒：Wukong Codex 需要单独下载本地 Qwen3-TTS 模型。"
        f"即将自动下载 {info['id']}（{info['displaySize']}），下载后会重复使用本机缓存。",
        file=sys.stderr,
        flush=True,
    )
    if dry_run:
        payload["dryRun"] = True
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    python = find_download_python(platform)
    if python is None:
        raise RuntimeError(
            "未找到带 huggingface_hub 的 Python。请先安装完整版 Wukong Codex，再重新运行自动下载。"
        )

    root.mkdir(parents=True, exist_ok=True)
    code = (
        "from huggingface_hub import snapshot_download; import sys; "
        "print(snapshot_download(repo_id=sys.argv[1], cache_dir=sys.argv[2]))"
    )
    environment = os.environ.copy()
    environment["HF_HUB_DISABLE_TELEMETRY"] = "1"
    subprocess.run(
        [str(python), "-c", code, str(info["id"]), str(root)],
        check=True,
        env=environment,
    )
    final = status_payload(platform, root)
    if not final["ready"]:
        raise RuntimeError("模型下载命令已结束，但完整快照校验失败")
    final["downloaded"] = True
    print(json.dumps(final, ensure_ascii=False))
    return 0


def main() -> int:
    args = parse_args()
    platform = platform_name(args.platform)
    root = cache_root(args.cache_dir)
    if args.download:
        return download_model(platform, root, args.dry_run)
    payload = status_payload(platform, root)
    if args.dry_run:
        payload["dryRun"] = True
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
