import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontend = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const tauriConfig = await readFile(
  new URL("../src-tauri/tauri.conf.json", import.meta.url),
  "utf8",
);
const summonAvatar = await readFile(
  new URL("../public/assets/jarvis-wukong-summon-head-transparent.png", import.meta.url),
);
const speakingAvatar = await readFile(
  new URL("../public/assets/jarvis-wukong-mouth-open.png", import.meta.url),
);
const summonHair = await readFile(
  new URL("../public/assets/wukong-single-hair-transparent.png", import.meta.url),
);
const appIcon = await readFile(
  new URL("../src-tauri/icons/icon.png", import.meta.url),
);
const wakeHelper = await readFile(
  new URL("../src-tauri/wake-helper/JarvisWakeListener.swift", import.meta.url),
  "utf8",
);
const entitlements = await readFile(
  new URL("../src-tauri/Entitlements.plist", import.meta.url),
  "utf8",
);
const helperEntitlements = await readFile(
  new URL("../src-tauri/wake-helper/Entitlements.plist", import.meta.url),
  "utf8",
);
const wakeBuildScript = await readFile(
  new URL("../scripts/build-wake-helper.sh", import.meta.url),
  "utf8",
);
const voiceWorker = await readFile(
  new URL("../src-tauri/voice-worker/voice_worker.py", import.meta.url),
  "utf8",
);
const windowsVoiceWorker = await readFile(
  new URL("../src-tauri/voice-worker/voice_worker_windows.py", import.meta.url),
  "utf8",
);
const windowsWakeHelper = await readFile(
  new URL("../src-tauri/wake-helper-windows/WukongWakeListener.ps1", import.meta.url),
  "utf8",
);
const windowsConfig = await readFile(
  new URL("../src-tauri/tauri.windows.conf.json", import.meta.url),
  "utf8",
);
const voiceReference = await readFile(
  new URL("../src-tauri/voice-worker/wukong-20260809-reference.wav", import.meta.url),
);
const voiceReferenceText = await readFile(
  new URL("../src-tauri/voice-worker/wukong-20260809-reference-transcript.txt", import.meta.url),
  "utf8",
);
const localVoiceSkill = await readFile(
  new URL("../skills/wukong-local-voice/SKILL.md", import.meta.url),
  "utf8",
);
const localVoiceModelScript = fileURLToPath(
  new URL(
    "../skills/wukong-local-voice/scripts/ensure_model.py",
    import.meta.url,
  ),
);

test("Codex text is spoken through the authorized local 8月9日 voice clone", () => {
  assert.match(backend, /const CODEX_WEBRTC_REALTIME_VERSION: &str = "v3"/);
  assert.match(backend, /const CODEX_WEBRTC_OUTPUT_MODALITY: &str = "audio"/);
  assert.match(backend, /"version":\s*CODEX_WEBRTC_REALTIME_VERSION/);
  assert.match(backend, /"outputModality":\s*CODEX_WEBRTC_OUTPUT_MODALITY/);
  assert.match(backend, /"transport":\s*\{"type":\s*"webrtc"/);
  assert.match(backend, /"app-server",\s*"--enable",\s*"realtime_conversation",\s*"--stdio"/);
  assert.match(backend, /"prompt": LOCAL_VOICE_TEXT_PROMPT/);
  assert.match(frontend, /Codex · Wukong 本地克隆声线/);
  assert.doesNotMatch(backend, /thread\/realtime\/listVoices/);
  assert.doesNotMatch(backend, /CODEX_V3_PREFERRED_VOICE|MYTHIC_MONKEY_VOICE_PROMPT/);
  assert.doesNotMatch(backend, /"voice"\s*:/);
  assert.match(backend, /stream_local_voice/);
  assert.match(backend, /local-voice-stream-chunk/);
  assert.match(frontend, /invoke<LocalVoiceStreamSummary>\("stream_local_voice"/);
  assert.match(frontend, /listen<LocalVoiceStreamChunk>\("local-voice-stream-chunk"/);
  assert.match(frontend, /invoke<LocalVoiceStatus>\("prepare_local_voice"\)/);
  assert.match(frontend, /invoke\("play_local_voice", \{ path: item\.audio\.path \}\)/);
  assert.match(frontend, /invoke\("stop_local_voice_playback"\)/);
  assert.match(backend, /Command::new\("\/usr\/bin\/afplay"\)/);
  assert.match(backend, /audio_path\.starts_with\(&allowed_root\)/);
  assert.match(backend, /local_voice_playback_pid: AtomicU32/);
  assert.match(frontend, /event\.track\.enabled = false/);
  assert.doesNotMatch(frontend, /voiceAudio\.srcObject = remoteStream/);
  assert.match(frontend, /convertFileSrc\(item\.audio\.path\)/);
  assert.match(backend, /Qwen3-TTS-12Hz-0\.6B-Base-4bit/);
  assert.doesNotMatch(backend, /HF_HUB_OFFLINE/);
  assert.match(backend, /stop_stale_local_voice_worker/);
  assert.match(backend, /worker\.pid/);
  assert.match(backend, /\.kill_on_drop\(true\)/);
  assert.match(backend, /wukong-20260809-reference\.wav/);
  assert.match(voiceWorker, /streaming_interval=0\.8/);
  assert.match(voiceWorker, /np\.concatenate\(audio_chunks\)/);
  assert.match(voiceWorker, /cached_speaker_embedding/);
  assert.match(voiceReferenceText, /人，我保住了。经，我取到了。/);
  assert.equal(voiceReference.subarray(0, 4).toString(), "RIFF");
  assert.equal(voiceReference.readUInt32LE(24), 24_000);
  assert.equal(voiceReference.readUInt16LE(22), 1);
  assert.doesNotMatch(`${backend}\n${frontend}`, /MiniMax|minimax|ElevenLabs|elevenlabs|xi-api-key|API Key/);
  assert.doesNotMatch(backend, /reqwest/);
  assert.match(tauriConfig, /voice-worker\//);
  assert.match(windowsConfig, /voice_worker_windows\.py/);
  assert.match(tauriConfig, /"assetProtocol"/);
  assert.match(tauriConfig, /\$APPDATA\/local-voice\/generated\/\*\.wav/);
  assert.match(backend, /app_data_dir\(\)/);
  assert.doesNotMatch(frontend, /OPENAI_API_KEY|ChatGPT.*button|hotkey/i);
});

test("the installed product is named Wukong Codex and uses the Wukong portrait icon", () => {
  assert.match(tauriConfig, /"productName": "Wukong Codex"/);
  assert.match(tauriConfig, /"title": "WUKONG · CODEX"/);
  assert.match(tauriConfig, /"identifier": "com\.xboyzc\.wukong-codex"/);
  assert.match(backend, /"title": "Wukong Codex"/);
  assert.deepEqual([...appIcon.subarray(1, 4)], [80, 78, 71]);
  assert.equal(appIcon.readUInt32BE(16), 512);
  assert.equal(appIcon.readUInt32BE(20), 512);
  assert.equal(appIcon[25], 6, "app icon must keep transparent rounded corners");
});

test("Windows has native wake, playback, Codex discovery, and local Qwen voice", () => {
  assert.match(backend, /Qwen\/Qwen3-TTS-12Hz-0\.6B-Base/);
  assert.match(backend, /voice_worker_windows\.py/);
  assert.match(backend, /System\.Media\.SoundPlayer/);
  assert.match(backend, /where\.exe/);
  assert.match(backend, /taskkill\.exe/);
  assert.match(backend, /WukongWakeListener\.ps1/);
  assert.match(windowsVoiceWorker, /Qwen3TTSModel\.from_pretrained/);
  assert.match(windowsVoiceWorker, /generate_voice_clone/);
  assert.match(windowsVoiceWorker, /attn_implementation="sdpa"/);
  assert.match(windowsWakeHelper, /SpeechRecognitionEngine/);
  assert.match(windowsWakeHelper, /InstalledRecognizers/);
  assert.match(windowsWakeHelper, /黑悟空/);
  assert.match(windowsWakeHelper, /DictationGrammar/);
  assert.match(windowsConfig, /"targets": \["nsis"\]/);
  assert.match(windowsConfig, /voice-runtime\//);
});

test("the downloadable Skill reminds once and prepares models outside GitHub", () => {
  assert.match(localVoiceSkill, /第一次调用|first invocation/i);
  assert.match(localVoiceSkill, /--download/);
  assert.match(localVoiceSkill, /never add them to Git|Never commit/i);
  assert.match(localVoiceSkill, /1\.71 GB/);
  assert.match(localVoiceSkill, /2\.52 GB/);

  const python = process.platform === "win32" ? "python" : "python3";
  const cache = mkdtempSync(join(tmpdir(), "wukong-skill-model-check-"));
  try {
    for (const platform of ["macos", "windows"]) {
      const output = execFileSync(
        python,
        [
          localVoiceModelScript,
          "--check",
          "--platform",
          platform,
          "--cache-dir",
          cache,
        ],
        { encoding: "utf8" },
      );
      const status = JSON.parse(output);
      assert.equal(status.platform, platform);
      assert.equal(status.ready, false);
      assert.equal(status.downloadRequired, true);
      assert.match(status.modelId, /Qwen3-TTS/);
    }
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("local cloned speech keeps one stable voice per assistant reply", () => {
  assert.match(frontend, /function queueLocalVoice\(text: string, delay = 320\)/);
  assert.match(frontend, /function pushLocalVoiceDelta\(delta: string\)/);
  assert.match(frontend, /function finishLocalVoiceStream\(finalText: string\)/);
  assert.match(frontend, /enqueueLocalVoiceChunk\(cleanedFinal\)/);
  assert.match(frontend, /localSpeechTextQueue: LocalSpeechJob\[\]/);
  assert.match(frontend, /localSpeechAudioQueue: LocalSpeechAudio\[\]/);
  assert.match(frontend, /drainLocalVoiceGenerationQueue/);
  assert.match(frontend, /drainLocalVoicePlaybackQueue/);
  assert.match(frontend, /localSpeechAudioQueue\.push\(\{/);
  assert.match(frontend, /pushLocalVoiceDelta\(delta\)/);
  assert.match(frontend, /finishLocalVoiceStream\(text\)/);
  assert.match(frontend, /queueLocalVoice\(text, 120\)/);
  assert.match(frontend, /cancelLocalVoice\(true\)/);
  assert.match(frontend, /job\.revision !== localSpeechRevision/);
  assert.match(voiceWorker, /temperature=0\.2/);
  assert.doesNotMatch(frontend, /speakLocalVoice/);
  assert.match(frontend, /id="reload-local-voice"/);
  assert.match(frontend, /不调用付费语音 API/);
  assert.match(frontend, /new Blob\(\[bytes\], \{ type: "audio\/wav" \}\)/);
  assert.match(backend, /spoken summary of at most 42 Chinese characters/);
});

test("wake phrase opens the stable local-listen Codex conversation path", () => {
  assert.match(frontend, /listen<WakeEvent>\("jarvis-wake"/);
  assert.match(frontend, /void activateCodexConversation\(\)/);
  assert.match(frontend, /async function activateCodexConversation\(\)/);
  assert.match(frontend, /async function startCodexConversationListener\(\)/);
  assert.match(frontend, /async function handleCodexConversationUtterance\(text: string\)/);
  assert.match(frontend, /await invoke\("send_text", \{ text: spoken \}\)/);
  assert.match(frontend, /LOCAL LISTEN · CODEX/);
  assert.match(backend, /"--host-app"/);
  assert.match(wakeHelper, /NSWorkspace\.shared\.openApplication/);
  assert.match(wakeHelper, /configuration\.arguments\s*=\s*\["--jarvis-wake"\]/);
  assert.match(frontend, /consume_cold_wake/);
  assert.match(backend, /AVAudioEngine releases the input device asynchronously/);
  assert.match(backend, /matches!\(authorization, "denied" \| "restricted"\)/);
  assert.match(backend, /requestAccessForMediaType_completionHandler/);
  assert.match(frontend, /request_microphone_permission/);
  assert.match(frontend, /startup_is_background/);
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(helperEntitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(backend, /tauri_plugin_autostart/);
  assert.match(backend, /ensure_background_launch_agent/);
  assert.match(backend, /<key>KeepAlive<\/key>\s*\n\s*<false\/>/);
  assert.doesNotMatch(backend, /<key>KeepAlive<\/key>\s*\n\s*<true\/>/);
  assert.match(backend, /<key>ThrottleInterval<\/key>/);
  assert.match(frontend, /onCloseRequested/);
  assert.match(wakeHelper, /"--test-wake"/);
  assert.match(wakeHelper, /"--test-phrase"/);
  assert.match(wakeHelper, /"wake-test-pass"/);
  assert.match(wakeHelper, /"嗨悟空"/);
  assert.match(wakeHelper, /"嘿悟空"/);
  assert.match(wakeHelper, /"黑悟空"/);
  assert.match(wakeHelper, /private func isWakePhrase/);
  assert.match(wakeHelper, /"无空", "吴空", "五空"/);
  assert.match(wakeHelper, /"type": "heard"/);
  assert.match(wakeBuildScript, /preserving its existing macOS permission identity/);
  assert.match(wakeBuildScript, /codesign --verify --deep --strict/);
  assert.doesNotMatch(wakeHelper, /嗨jarvis|嘿jarvis|hijarvis|heyjarvis|嗨贾维斯|嘿贾维斯/i);
  assert.match(frontend, /嗨 悟空/);
});

test("the first wake phrase is relayed after the summon effect and gets an answer", () => {
  assert.match(frontend, /formationStartedAt \+ FORMATION_DURATION - performance\.now\(\)/);
  assert.match(frontend, /response\.textContent = "我在，你说。"/);
  assert.match(frontend, /queueLocalVoice\("我在，你说。", 0\)/);
  assert.match(frontend, /void startCodexConversationListener\(\)/);
});

test("opening the app manually triggers the same summon effect and greeting", () => {
  assert.match(backend, /app\.emit\("jarvis-manual-summon", true\)/);
  assert.match(backend, /argument == "--jarvis-wake"/);
  assert.match(backend, /tauri::RunEvent::Reopen/);
  assert.match(backend, /if !has_visible_windows/);
  assert.match(frontend, /listen<boolean>\("jarvis-manual-summon"/);
  assert.match(frontend, /if \(!backgroundStart \|\| coldWake\) void activateCodexConversation\(\)/);
  assert.match(frontend, /setMode\("voice-starting"\)/);
  assert.match(frontend, /queueLocalVoice\("我在，你说。", 0\)/);
});

test("usage exhaustion never starts a local answer model", () => {
  assert.match(frontend, /function isCodexUsageLimitError/);
  assert.match(frontend, /purchase more credits/);
  assert.match(frontend, /function formatCodexUsageLimitNotice/);
  assert.match(frontend, /id="degraded-title"/);
  assert.match(frontend, /CODEX 在线额度已用完/);
  assert.match(frontend, /本地回答模型仍未启用/);
  assert.doesNotMatch(frontend, /activateLocalFallback|generate_local_reply|prepare_local_chat|Local Qwen/);
  assert.match(frontend, /listen<LocalUtterance>\("jarvis-local-utterance"/);
  assert.match(frontend, /start_local_fallback_listener/);
  assert.doesNotMatch(backend, /LocalChatRuntime|generate_local_reply/);
  assert.match(backend, /async fn start_local_fallback_listener/);
  assert.match(wakeHelper, /CommandLine\.arguments\.contains\("--conversation"\)/);
  assert.match(wakeHelper, /"type": "utterance"/);
  assert.match(wakeHelper, /scheduleConversationUtterance/);
  assert.doesNotMatch(tauriConfig, /voice-worker\/local_chat_worker\.py/);
  assert.doesNotMatch(frontend, /<b>JARVIS NEEDS PERMISSION<\/b>/);
});

test("STOP suppresses transcript-tail handoffs and interrupts late turns", () => {
  assert.match(backend, /"flushTranscriptTailOnSessionEnd":\s*false/);
  assert.match(backend, /for _ in 0\.\.6/);
  assert.match(backend, /"turn\/interrupt"/);
});

test("conversation waits for the user and avoids duplicate app instances", () => {
  assert.match(backend, /"delegationAckFiller":\s*false/);
  assert.match(backend, /tauri_plugin_single_instance::init/);
  assert.match(backend, /arguments\.iter\(\)\.any\(\|argument\| argument == "--background"\)/);
  assert.match(backend, /async fn quit_app/);
  assert.match(frontend, /id="quit-app"/);
  assert.match(frontend, /invoke\("quit_app"\)/);
  assert.doesNotMatch(frontend, /session:\s*\{\s*type:\s*"realtime"/);
  assert.match(frontend, /问题与任务由在线 Codex 处理/);
  assert.match(frontend, /invoke\("start_local_fallback_listener"\)/);
  assert.match(backend, /"turn\/start"/);
  assert.match(frontend, /realtimeEventsChannel\?\.close\(\)/);
});

test("delegated Codex work never mutes the ongoing Wukong conversation", () => {
  assert.match(frontend, /assistantTranscriptBuffer \+= delta;[\s\S]*pushLocalVoiceDelta\(delta\)/);
  assert.match(frontend, /!state\.directVoice\?\.voiceActive && !codexConversationMode/);
  assert.match(frontend, /if \(codexConversationMode\) pushLocalVoiceDelta\(delta\)/);
  assert.match(frontend, /function scheduleAgentProgressNotices/);
  assert.match(frontend, /我还在处理，你可以继续跟我说话/);
  assert.match(frontend, /window\.setTimeout\(announce, 8_000\)/);
  assert.match(frontend, /window\.setTimeout\(announce, 18_000\)/);
  assert.doesNotMatch(frontend, /if \(!state\.agentWorking\) \{\s*pushLocalVoiceDelta/);
});

test("text input joins the stable spoken Codex conversation", () => {
  assert.match(frontend, /if \(codexConversationMode\) \{\s*await handleCodexConversationUtterance\(text\)/);
  assert.match(backend, /"turn\/start"/);
});

test("production configuration persists workspace and resumes threads", () => {
  assert.match(frontend, /jarvis\.workspace/);
  assert.match(frontend, /jarvis\.threadId:/);
  assert.match(backend, /"thread\/resume"/);
  assert.match(backend, /validated_workspace/);
  assert.match(wakeHelper, /requiresOnDeviceRecognition = true/);
});

test("user can create a fresh Codex thread without deleting history", () => {
  assert.match(frontend, /id="new-thread"/);
  assert.match(frontend, /threadId:\s*null/);
  assert.match(frontend, /invoke<Session>\("start_jarvis"/);
  assert.match(frontend, /freshSession\.threadId/);
  assert.match(frontend, /原线程仍保留在 Codex 历史记录中/);
});

test("permission profiles are persisted and mapped by the trusted backend", () => {
  assert.match(frontend, /jarvis\.permissionMode/);
  assert.match(frontend, /type PermissionMode = "safe" \| "auto" \| "full"/);
  assert.match(frontend, /permissionMode,/);
  assert.match(backend, /enum PermissionMode/);
  assert.match(backend, /approval_policy: "on-request"/);
  assert.match(backend, /approval_policy: "never"/);
  assert.match(backend, /sandbox: "workspace-write"/);
  assert.match(backend, /sandbox: "danger-full-access"/);
  assert.match(backend, /existing\.permission_mode == permission_mode/);
});

test("wake activates the macOS app before focusing the Jarvis window", () => {
  assert.match(backend, /fn raise_jarvis_window/);
  assert.match(backend, /activateIgnoringOtherApps\(true\)/);
  assert.match(backend, /set_always_on_top\(true\)/);
  assert.match(backend, /set_always_on_top\(false\)/);
  assert.match(backend, /raise_jarvis_window\(&app\)/);
});

test("spoken answers and AI news remain visibly readable on the Wukong screen", () => {
  const avatarHiddenRule = stylesheet.match(
    /\.visual-source,[^{]+\{display:none!important\}/,
  )?.[0] ?? "";
  assert.doesNotMatch(avatarHiddenRule, /\.dialogue/);
  assert.match(frontend, /id="assistant-transcript"/);
  assert.match(stylesheet, /\.dialogue\{[\s\S]*?left:34px[\s\S]*?width:clamp\(320px,25vw,480px\)/);
  assert.match(stylesheet, /\.dialogue\{[\s\S]*?transform:translateY\(-50%\)/);
  assert.match(stylesheet, /\.dialogue p\{[\s\S]*?white-space:pre-wrap/);
  assert.match(stylesheet, /overflow-wrap:anywhere/);
});

test("Wukong summon portrait stays transparent without the orange Buddha halo", () => {
  const assetName = "jarvis-wukong-summon-head-transparent.png";
  assert.match(frontend, new RegExp(assetName.replaceAll(".", "\\.")));
  assert.equal(stylesheet.match(new RegExp(assetName.replaceAll(".", "\\."), "g"))?.length, 2);
  assert.deepEqual([...summonAvatar.subarray(1, 4)], [80, 78, 71]);
  assert.equal(summonAvatar[25], 6, "PNG must use RGBA color type");
  assert.match(stylesheet, /mask-image:linear-gradient\(to bottom/);
  assert.match(stylesheet, /\.character-rig::before,\.character-rig::after\{content:none\}/);
  assert.doesNotMatch(stylesheet, /buddha-halo-breathe/);
  assert.doesNotMatch(stylesheet, /buddha-inner-breathe/);
  assert.doesNotMatch(frontend, /armor-shard|assembly-orbits/);
  assert.doesNotMatch(stylesheet, /armor-shard|assembly-orbits/);
  assert.doesNotMatch(stylesheet, /wukong-core-summon/);
});

test("one horizontal Wukong hair splits into particles before the portrait forms", () => {
  assert.deepEqual([...summonHair.subarray(1, 4)], [80, 78, 71]);
  assert.equal(summonHair[25], 6, "summon hair PNG must use RGBA color type");
  assert.match(frontend, /id="summon-hair" class="summon-hair"/);
  assert.match(frontend, /const FORMATION_DURATION = 4200/);
  assert.match(frontend, /function placeParticleOnHair/);
  assert.match(frontend, /function drawHairSplitEnergy/);
  assert.match(frontend, /if \(progress < \.3\)/);
  assert.match(stylesheet, /@keyframes summon-hair-flight-split/);
  assert.match(stylesheet, /translateX\(-92vw\) rotate\(84deg\)/);
  assert.match(stylesheet, /@keyframes fur-particle-materialize/);
});

test("Wukong mouth follows only the assistant response audio", () => {
  assert.deepEqual([...speakingAvatar.subarray(1, 4)], [80, 78, 71]);
  assert.match(frontend, /class="mouth-pose" src="\/assets\/jarvis-wukong-mouth-open\.png"/);
  assert.match(frontend, /const voiceAudio = new Audio\(\)/);
  assert.match(frontend, /nativeVoicePlaybackActive/);
  assert.doesNotMatch(frontend, /const nativeLevel|Math\.sin\(\(performance\.now\(\) - nativeVoicePlaybackStartedAt/);
  assert.match(frontend, /voiceAudio\.autoplay = true/);
  assert.match(frontend, /ensureVoiceAudioAnalyser/);
  assert.match(frontend, /createMediaElementSource\(voiceAudio\)/);
  assert.match(frontend, /new Blob\(\[bytes\], \{ type: "audio\/wav" \}\)/);
  assert.match(frontend, /URL\.createObjectURL\(new Blob/);
  assert.match(frontend, /voiceAudio\.play\(\)/);
  assert.match(frontend, /voiceAudio\.currentTime/);
  assert.match(frontend, /function buildPcmWavEnvelope/);
  assert.match(frontend, /rawCrossings/);
  assert.match(frontend, /localVoiceEnvelope\?\.widths\[envelopeIndex\]/);
  assert.match(frontend, /localVoiceEnvelope\?\.heights\[envelopeIndex\]/);
  assert.doesNotMatch(frontend, /attachAnalyser\(remoteStream, "remote"\)/);
  assert.match(frontend, /remoteSpeechLevel \+= \(speakerLevel - remoteSpeechLevel\)/);
  assert.match(frontend, /mouthHoldUntil = performance\.now\(\) \+ 140/);
  assert.match(frontend, /\(remoteSpeechLevel - \.006\) \/ \.24/);
  assert.match(frontend, /shell\.style\.setProperty\("--mouth-open", "0"\)/);
  assert.match(frontend, /shell\.style\.setProperty\("--mouth-width"/);
  assert.match(frontend, /shell\.style\.setProperty\("--mouth-height"/);
  assert.match(stylesheet, /\.mouth-pose\{/);
  assert.match(stylesheet, /at 50% 80\.8%/);
  assert.match(stylesheet, /scaleX\(var\(--mouth-width\)\) scaleY\(var\(--mouth-height\)\)/);
});
