---
name: wukong-local-voice
description: Prepare, diagnose, or repair the local Qwen3-TTS voice-cloning model used by Wukong Codex. Use when a user installs or downloads the Wukong Skill, asks to enable the authorized local voice, sees a missing-model error, or wants the correct macOS or Windows model downloaded automatically without adding model weights to GitHub.
---

# Wukong Local Voice

Prepare the platform-specific Qwen3-TTS model for Wukong Codex. Keep all model weights in the user's local Hugging Face cache; never add them to Git or a GitHub Release.

## First-use workflow

1. Run the bundled status check from this skill directory:

   ```bash
   python3 scripts/ensure_model.py --check
   ```

   On Windows, use `python` if `python3` is unavailable.

2. If `ready` is `true`, report the detected model and stop. Do not download it again.

3. If `downloadRequired` is `true`, tell the user before the transfer starts:

   - Wukong Codex needs a separate local Qwen3-TTS model.
   - The model is intentionally excluded from GitHub.
   - macOS Apple Silicon downloads `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit` (about 1.71 GB).
   - Windows x64 downloads `Qwen/Qwen3-TTS-12Hz-0.6B-Base` (about 2.52 GB).
   - The transfer needs a stable internet connection and is reused from the local cache afterward.

4. Unless the user explicitly asks not to download, start the automatic download after sending that notice:

   ```bash
   python3 scripts/ensure_model.py --download
   ```

5. Run `--check` again. Only report success when `ready` is `true`.

6. Start Wukong Codex and verify that its bundled Qwen worker is running. Explain that Qwen3-TTS generates speech locally, while Codex still supplies the answer text.

## Guardrails

- Never claim that copying the Skill itself can execute a post-install hook. The first invocation performs the check and download.
- Never commit `*.safetensors`, Hugging Face cache folders, or downloaded model snapshots.
- Never request a MiniMax, ElevenLabs, or other paid voice API key.
- Preserve the user's authorized reference recording and matching transcript.
- Do not download again when a complete cached snapshot already exists.
- If automatic download cannot find Python with `huggingface_hub`, ask the user to install the full Wukong Codex application, then retry.

## Script options

- `--check`: Print JSON model status without network access.
- `--download`: Print the required reminder, locate the Wukong bundled Python runtime, and download through `huggingface_hub`.
- `--dry-run`: Show the selected platform and model without downloading.
- `--platform macos|windows`: Override platform detection for validation only.
- `--cache-dir PATH`: Override the Hugging Face cache for testing or controlled installations.
