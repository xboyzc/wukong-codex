<p align="center">
  <img src="src-tauri/icons/icon.png" width="160" alt="Wukong Codex 图标">
</p>

<h1 align="center">Wukong Codex</h1>

<p align="center">对电脑说“黑悟空”或“嗨 悟空”，唤醒你的本地黑悟空 Codex 智能体。</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文 ·
  <a href="https://github.com/xboyzc/wukong-codex/releases/latest">下载 macOS / Windows 安装包</a>
</p>

Wukong Codex 是一个 Tauri 桌面智能体：猪八戒不来，黑悟空来。唤醒后，毫毛粒子入场动效会形成悟空头像，问题交给 Codex 处理，回答用你授权的 8 月 9 日录音在本机克隆声线并驱动嘴形。

## 直接使用

1. 从 [Releases](https://github.com/xboyzc/wukong-codex/releases/latest) 下载对应安装包：
   - Apple Silicon Mac：`.dmg`
   - Windows x64：`.exe`
2. 安装并打开 `Wukong Codex`，允许麦克风和语音识别。
3. 确保电脑已安装 Codex CLI，并已登录：

   ```bash
   npm install -g @openai/codex
   codex login
   ```

4. 首次准备声线时保持联网；程序会下载开源 Qwen3-TTS 模型，之后重用本机缓存。
5. 关闭主窗口后程序会留在后台。说“黑悟空”或“嗨 悟空”，动效完成后直接说出任务。

### Windows 额外要求

Windows 需要安装“中文（简体）”的语音识别语言包，否则程序会明确提示无法启动唤醒监听。Windows 10/11 通常已有 WebView2；安装器会在缺失时联网获取。

## 声线与隐私

- 声线合成不调用 MiniMax、ElevenLabs 或其他付费语音 API。
- macOS 使用 MLX + Qwen3-TTS；Windows 使用 PyTorch + Qwen3-TTS。
- 参考录音是仓库拥有者明确授权的本人录音。
- 这是公开仓库：包内的参考声音片段会被任何人下载。不接受这一点时，请删除参考 WAV 并改成私有仓库。
- 模型下载后，声音生成在本机执行。Codex 问答仍需要 Codex 服务和你自己的登录/用量权限。

## 公开构建的签名说明

自动构建产物目前没有 Apple Developer ID 和 Windows 代码签名证书。系统可能显示“未知开发者”或 SmartScreen 警告。只应从本仓库 Releases 下载，并在确认发布者为 `xboyzc` 后手动允许打开。

## 开发与验证

基础环境：Node.js 20+ 、Rust stable 。macOS 还需 Xcode Command Line Tools；Windows 需 Visual Studio C++ Build Tools 与 WebView2 开发环境。

```bash
npm ci
npm run check:macos     # macOS
npm run check:windows   # Windows
npm run dev
```

GitHub Actions 会在真实 `macos-14` Apple Silicon 和 `windows-2022` x64 构建机上分别编译。自动编译通过不等于麦克风、系统授权和音频输出已经在每一台 Windows 实机上验证，发布前仍应做一次 Windows 11 实机烟雾测试。

## 项目边界

- 不在仓库中保存 Codex 登录信息、API Key 或聊天内容。
- 不把“可以编译”写成“已经完成两端语音实机验证”。
- 视觉素材与授权录音的权利说明见 [assets/NOTICE.md](assets/NOTICE.md)。

代码使用 [GPL-3.0](LICENSE) 开源。
