<p align="center"><img src="src-tauri/icons/icon.png" width="160" alt="Wukong Codex icon"></p>
<h1 align="center">Wukong Codex</h1>
<p align="center">Say “Hei Wukong” / “Hi Wukong” in Mandarin to wake a local Wukong interface for Codex.</p>

<p align="center"><a href="README.zh-CN.md">简体中文</a> · <a href="https://github.com/xboyzc/wukong-codex/releases/latest">Download for macOS / Windows</a></p>

Wukong Codex combines a Tauri desktop interface, native wake-word recognition, Codex app-server conversations, a Wukong particle summon effect, locally cloned Qwen3-TTS speech, and audio-driven lip sync.

## Install

1. Download the Apple Silicon `.dmg` or Windows x64 `.exe` from [Releases](https://github.com/xboyzc/wukong-codex/releases/latest).
2. Install and allow microphone/speech-recognition access.
3. Install and sign in to Codex CLI:

   ```bash
   npm install -g @openai/codex
   codex login
   ```

4. Keep an internet connection for the first voice initialization. The open Qwen model is downloaded once, then reused from the local cache.
5. Leave Wukong Codex running in the background and say “黑悟空” or “嗨 悟空”.

Windows requires the Simplified Chinese speech-recognition language pack. The installer downloads WebView2 when it is missing.

## Local authorized voice

macOS uses MLX + Qwen3-TTS. Windows uses PyTorch + Qwen3-TTS. Synthesis does not call MiniMax, ElevenLabs, or another paid speech API. Codex answers still require the user's own Codex login and usage entitlement.

This is a public repository. Its short reference WAV is the repository owner's explicitly authorized personal recording and can be downloaded by anyone. See [assets/NOTICE.md](assets/NOTICE.md) before redistributing the media assets.

## Codex Skill: automatic local-model setup

The repository includes the [`wukong-local-voice`](skills/wukong-local-voice/SKILL.md) Skill without model weights. On its first invocation, `$wukong-local-voice` reports the platform-specific download size and network requirement, then downloads the correct Qwen3-TTS model automatically. Later invocations reuse the local Hugging Face cache.

Copying a Skill cannot execute a post-install hook, so the reminder and download occur on first invocation rather than at file-copy time. Model weights are excluded by `.gitignore` and must never be committed to GitHub.

In Codex, ask: `Install the Skill from https://github.com/xboyzc/wukong-codex/tree/main/skills/wukong-local-voice`.

## Development

```bash
npm ci
npm run check:macos     # macOS
npm run check:windows   # Windows
npm run dev
```

GitHub Actions compiles on Apple Silicon macOS and x64 Windows runners. A successful build is not presented as proof that microphone permissions, speech packs, and audio hardware have passed on every Windows machine; a Windows 11 hardware smoke test is still required.

Automated public installers are currently unsigned and may trigger Gatekeeper or SmartScreen. Download only from this repository's Releases page.

Code is licensed under [GPL-3.0](LICENSE).
