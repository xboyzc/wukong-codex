import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./style.css";

type Mode = "booting" | "ready" | "voice-starting" | "listening" | "working" | "speaking" | "degraded" | "stopped";
type Message = { id?: number | string; method?: string; params?: any };
type Session = { threadId: string; cwd: string };
type DirectVoice = {
  codexConnected: boolean;
  voiceActive: boolean;
  phase: string;
  protocol: string;
  threadId?: string;
  realtimeSessionId?: string;
};
type WakeStatus = {
  enabled: boolean;
  ready: boolean;
  authorization: string;
};
type WakeEvent = {
  ok: boolean;
  error?: string;
  cold?: boolean;
};
type LocalVoiceAudio = {
  path: string;
  durationMs: number;
  generationMs: number;
};
type LocalVoiceStreamChunk = LocalVoiceAudio & {
  streamId: string;
  chunkIndex: number;
};
type LocalVoiceStreamSummary = {
  durationMs: number;
  generationMs: number;
  chunkCount: number;
};
type LocalVoiceStatus = {
  configured: boolean;
  ready: boolean;
  provider: string;
  modelId: string;
  voiceName: string;
  referenceAudio: string;
  loadMs?: number;
};
type LocalUtterance = { text: string };
type PermissionMode = "safe" | "auto" | "full";

const state = {
  mode: "booting" as Mode,
  session: null as Session | null,
  directVoice: null as DirectVoice | null,
  wake: null as WakeStatus | null,
  level: 0,
  manualStop: false,
  agentWorking: false,
};

const WORKSPACE_KEY = "jarvis.workspace";
const THREAD_KEY_PREFIX = "jarvis.threadId:";
const PERMISSION_KEY = "jarvis.permissionMode";
const permissionLabels: Record<PermissionMode, string> = {
  safe: "安全模式 · 需要时确认",
  auto: "自动办公 · 当前目录自主执行",
  full: "完全访问 · 高风险",
};
function storedPermissionMode(): PermissionMode {
  const value = localStorage.getItem(PERMISSION_KEY);
  return value === "safe" || value === "full" ? value : "auto";
}
let workspace = "";
let permissionMode = storedPermissionMode();
const savedThreadId = () => localStorage.getItem(`${THREAD_KEY_PREFIX}${workspace}`);
let peer: RTCPeerConnection | null = null;
let realtimeEventsChannel: RTCDataChannel | null = null;
let microphoneStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let microphoneAnalyser: AnalyserNode | null = null;
let remoteAnalyser: AnalyserNode | null = null;
const voiceAudio = new Audio();
voiceAudio.autoplay = true;
voiceAudio.preload = "auto";
let voiceAudioSource: MediaElementAudioSourceNode | null = null;
let voiceAudioBlobUrl: string | null = null;
let voiceAudioCancelPlayback: (() => void) | null = null;
let nativeVoicePlaybackActive = false;
let nativeVoicePlaybackStartedAt = 0;
let localVoiceEnvelope: {
  levels: Float32Array;
  widths: Float32Array;
  heights: Float32Array;
  frameMs: number;
} | null = null;
let userTranscriptBuffer = "";
let assistantTranscriptBuffer = "";
let agentMessageBuffer = "";
let voiceStartInFlight = false;
let recoverableColdStartError = false;
let wakeGreetingPending = false;
let wakeGreetingTimer: number | undefined;
type LocalSpeechJob = { text: string; revision: number };
type LocalSpeechAudio = LocalSpeechJob & { audio: LocalVoiceAudio };
let localSpeechRevision = 0;
let localSpeechScheduleTimer: number | undefined;
let localSpeechTextQueue: LocalSpeechJob[] = [];
let localSpeechAudioQueue: LocalSpeechAudio[] = [];
let localSpeechStreamJobs = new Map<string, LocalSpeechJob>();
let localSpeechStreamId = 0;
let localSpeechGenerating = false;
let localSpeechPlaying = false;
let localSpeechStreamActive = false;
let localSpeechBatchText = "";
let lastSpokenText = "";
let lastSpokenAt = 0;
let lastSpokenBatchText = "";
let localVoiceWarmup: Promise<LocalVoiceStatus> | null = null;
let codexUsageLimitActive = false;
let codexConversationMode = false;
let codexConversationListening = false;
let codexConversationBusy = false;
let agentProgressTimer: number | undefined;
const previewParams = new URLSearchParams(window.location.search);
const tauriInternals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
const currentWindow = typeof tauriInternals?.invoke === "function" ? getCurrentWindow() : null;
const previewModeValue = previewParams.get("preview");
const previewActionValue = previewParams.get("action");
const visualPreviewMode: Mode = ["booting", "ready", "voice-starting", "listening", "working", "speaking", "degraded", "stopped"].includes(previewModeValue ?? "")
  ? previewModeValue as Mode
  : "ready";
if (!currentWindow) {
  document.documentElement.classList.add("visual-preview");
  if (previewParams.get("grid") === "1") document.documentElement.classList.add("transparency-grid");
}
if (currentWindow) {
  void currentWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    await currentWindow.hide();
  });
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<main class="shell" data-mode="booting">
  <canvas id="particle-field" width="1440" height="900" aria-hidden="true"></canvas>
  <header class="topbar hud-panel">
    <div class="brand"><i></i><strong>JARVIS</strong><span></span><em>CODEX VOICE SYSTEM</em></div>
    <div class="status"><i></i><b id="mode-label">INITIALIZING</b></div>
    <button id="settings" class="icon-button" aria-label="设置">⌘</button>
  </header>
  <section class="stage">
    <div class="avatar-window">
      <div class="character-aura"></div>
      <div class="character-rig">
        <img id="jarvis-character" class="helmet-character" src="/assets/jarvis-wukong-summon-head-transparent.png" alt="透明背景的悟空头部召唤形象">
        <img class="mouth-pose" src="/assets/jarvis-wukong-mouth-open.png" alt="" aria-hidden="true">
        <div class="helmet-scan"></div>
        <div class="formation-flash" aria-hidden="true"></div>
      </div>
      <img id="summon-hair" class="summon-hair" src="/assets/wukong-single-hair-transparent.png" alt="" aria-hidden="true">
      <canvas id="wave" width="900" height="120"></canvas>
    </div>
    <div class="identity"><span>JARVIS CORE</span><b id="identity-state">SYSTEM BOOT</b></div>
  </section>
  <aside class="workers">
    <article class="worker active" data-role="orchestrator"><span>›_</span><div><b>Codex</b><small>Connecting</small></div><i></i></article>
    <article class="worker" data-role="developer"><span>⌬</span><div><b>Developer</b><small>Standby</small></div><i></i></article>
    <article class="worker" data-role="researcher"><span>⌕</span><div><b>Researcher</b><small>Standby</small></div><i></i></article>
    <article class="worker" data-role="reviewer"><span>✓</span><div><b>Reviewer</b><small>Standby</small></div><i></i></article>
  </aside>
  <section class="dialogue hud-panel">
    <b>YOU</b><p id="user-transcript">“嗨，悟空”</p>
    <b class="jarvis">JARVIS</b><p id="assistant-transcript">正在连接 Codex 原生任务线程…</p>
  </section>
  <footer class="controls">
    <button id="mic" class="control mic"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="8.25" y="3" width="7.5" height="11.5" rx="3.75"></rect><path d="M5.5 11.25v.75a6.5 6.5 0 0 0 13 0v-.75M12 18.5V22M8.75 22h6.5"></path></svg></span><b>WUKONG VOICE</b><small>LOCAL LISTEN · CODEX</small></button>
    <form id="command-form" class="command"><input id="command-input" aria-label="文字指令" placeholder="发送在线 Codex 文字任务…" autocomplete="off"><button>EXECUTE</button></form>
    <button id="stop" class="control stop"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect class="stop-mark" x="6.5" y="6.5" width="11" height="11" rx="1.8"></rect></svg></span><b>STOP</b><small>INTERRUPT ALL</small></button>
  </footer>
  <div id="degraded-banner" class="degraded-banner" hidden><b id="degraded-title">WUKONG CODEX 需要处理</b><span id="degraded-copy">正在检查运行状态。</span></div>
  <dialog id="approval"><h2>高风险操作确认</h2><p id="approval-copy">Codex 请求执行需要确认的动作。</p><div><button id="deny">拒绝</button><button id="approve">允许一次</button></div></dialog>
  <dialog id="settings-dialog">
    <h2>WUKONG CODEX SYSTEM</h2>
    <dl><dt>Wake phrase</dt><dd>黑悟空 / 嗨 悟空</dd><dt>Wake listener</dt><dd id="wake-auth">检测中</dd><dt>Codex thread</dt><dd id="thread-id">—</dd><dt>Workspace</dt><dd id="workspace">—</dd><dt>Permission</dt><dd id="permission-mode-label">—</dd><dt>Local voice</dt><dd id="voice-auth">检测中</dd></dl>
    <fieldset class="local-voice-setting">
      <legend>Wukong 本地本人声线</legend>
      <p id="local-voice-setup-status">已使用“8月9日.mp3”建立本地声线。4bit 模型只在这台 Mac 上运行，不上传录音，不调用付费语音 API。</p>
      <button id="reload-local-voice" type="button">重新加载本地声线</button>
    </fieldset>
    <label class="workspace-setting">工作目录<input id="workspace-setting" autocomplete="off" spellcheck="false"></label>
    <fieldset class="permission-setting"><legend>Codex 操作权限</legend><label><input type="radio" name="permission-mode" value="safe"><span><b>安全模式</b><small>超出当前目录或高风险操作时询问</small></span></label><label class="recommended"><input type="radio" name="permission-mode" value="auto"><span><b>自动办公</b><small>当前目录内自主执行，越界操作直接阻止</small></span><em>推荐</em></label><label class="danger"><input type="radio" name="permission-mode" value="full"><span><b>完全访问</b><small>不限制目录且不询问，请谨慎使用</small></span></label></fieldset>
    <p>唤醒词和连续语音由 macOS 本机识别；问题与任务由在线 Codex 处理；回答文字由本机 Wukong 声线生成 WAV 并播放，不调用任何付费语音 API。</p>
    <p>“新开线程”会结束当前任务并创建一个全新的 Codex thread；原线程仍保留在 Codex 历史记录中。</p>
    <div class="settings-actions"><button id="new-thread" class="new-thread">＋ 新开线程</button><button id="quit-app">退出程序</button><span></span><button id="save-settings">保存</button><button id="close-settings">关闭</button></div>
  </dialog>
</main>`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const shell = $<HTMLElement>(".shell");
const transcript = $("#user-transcript");
const response = $("#assistant-transcript");
const banner = $("#degraded-banner") as HTMLDivElement;
const degradedTitle = $("#degraded-title");
const mic = $("#mic") as HTMLButtonElement;
const approval = $("#approval") as HTMLDialogElement;
const settings = $("#settings-dialog") as HTMLDialogElement;
const characterRig = $<HTMLElement>(".character-rig");
const hoverControls = $<HTMLElement>(".controls");
const settingsButton = $<HTMLButtonElement>("#settings");
let controlsHideTimer: number | undefined;
let characterActionTimer: number | undefined;
let mouthOpenness = 0;
let mouthWidth = 1;
let mouthHeight = .72;
let mouthShapeWidth = 1;
let mouthShapeHeight = .72;
let remoteSpeechLevel = 0;
let mouthHoldUntil = 0;

function revealControls() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  shell.classList.add("controls-visible");
}

function scheduleControlsHide() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  controlsHideTimer = window.setTimeout(() => shell.classList.remove("controls-visible"), 1500);
}

type CharacterAction = "acknowledge" | "approval" | "complete" | "error";

function triggerCharacterAction(action: CharacterAction, duration = 1100) {
  if (characterActionTimer !== undefined) window.clearTimeout(characterActionTimer);
  for (const name of ["acknowledge", "approval", "complete", "error"] as const) {
    shell.classList.remove(`action-${name}`);
  }
  void shell.clientWidth;
  shell.classList.add(`action-${action}`);
  characterActionTimer = window.setTimeout(() => shell.classList.remove(`action-${action}`), duration);
}

for (const area of [characterRig, hoverControls, settingsButton]) {
  area.addEventListener("pointerenter", revealControls);
  area.addEventListener("pointerleave", scheduleControlsHide);
}
shell.addEventListener("focusin", (event) => {
  if (event.target instanceof Element && (hoverControls.contains(event.target) || settingsButton.contains(event.target))) revealControls();
});
shell.addEventListener("focusout", scheduleControlsHide);

let approvalId: number | string | undefined;
const copy: Record<Mode, [string, string]> = {
  booting: ["INITIALIZING", "SYSTEM BOOT"], ready: ["READY", "CODEX VOICE STANDBY"],
  "voice-starting": ["VOICE LINKING", "AWAKENING WUKONG"], listening: ["LISTENING", "WUKONG VOICE ONLINE"],
  working: ["CODEX WORKING", "TASK EXECUTION"], speaking: ["JARVIS SPEAKING", "VOICE OUTPUT"],
  degraded: ["ATTENTION NEEDED", "CODEX VOICE OFFLINE"], stopped: ["INTERRUPTED", "ALL SYSTEMS HALTED"],
};

function setMode(mode: Mode) {
  state.mode = mode; shell.setAttribute("data-mode", mode);
  $("#mode-label").textContent = copy[mode][0]; $("#identity-state").textContent = copy[mode][1];
  if (mode === "voice-starting") {
    shell.classList.remove("is-forming");
    void shell.clientWidth;
    shell.classList.add("is-forming");
    startParticleFormation();
  }
}

function runtimeErrorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isCodexUsageLimitError(error: unknown) {
  return /usage limit|purchase more credits|codex\/settings\/usage|使用额度|额度已用完/i
    .test(runtimeErrorText(error));
}

function formatCodexUsageLimitNotice(error: unknown) {
  const raw = runtimeErrorText(error);
  const retry = raw.match(/try again at\s+(.+?)(?:\.|$)/i)?.[1]?.trim();
  return retry
    ? `Codex 使用额度已用完，当前无法生成回答。预计可在 ${retry} 后重试。`
    : "Codex 使用额度已用完，当前无法生成回答。请等待额度恢复后再试。";
}

function showRuntimeFailure(error: unknown) {
  const raw = runtimeErrorText(error);
  const usageLimit = isCodexUsageLimitError(raw);
  const permissionIssue = /permission|notallowed|denied|restricted|麦克风|语音识别|系统设置/i.test(raw);
  triggerCharacterAction("error");
  setMode("degraded");
  banner.hidden = false;
  if (usageLimit) {
    codexUsageLimitActive = true;
    degradedTitle.textContent = "CODEX 在线额度已用完";
    const notice = `${formatCodexUsageLimitNotice(raw)} 本地回答模型仍未启用；本地声线只负责播放已有文字。`;
    $("#degraded-copy").textContent = notice;
    response.textContent = notice;
    return true;
  }
  codexUsageLimitActive = false;
  degradedTitle.textContent = permissionIssue
    ? "WUKONG CODEX 需要系统权限"
    : "WUKONG CODEX 连接失败";
  $("#degraded-copy").textContent = raw;
  response.textContent = raw;
  return false;
}
function setWorker(role: string, label: string, active = true) {
  const card = document.querySelector<HTMLElement>(`.worker[data-role="${role}"]`);
  if (!card) return;
  card.classList.toggle("active", active); card.querySelector("small")!.textContent = label;
}

function stopAgentProgressNotices() {
  if (agentProgressTimer !== undefined) window.clearTimeout(agentProgressTimer);
  agentProgressTimer = undefined;
}

function scheduleAgentProgressNotices() {
  stopAgentProgressNotices();
  const announce = () => {
    if (!state.agentWorking || state.manualStop) {
      stopAgentProgressNotices();
      return;
    }
    if (!isVoicePlaybackActive() && !localSpeechPlaying && !localSpeechGenerating
      && localSpeechScheduleTimer === undefined
      && !localSpeechTextQueue.length && !localSpeechAudioQueue.length
      && !assistantTranscriptBuffer) {
      queueLocalVoice("我还在处理，你可以继续跟我说话。完成后我会马上告诉你。", 80);
    }
    agentProgressTimer = window.setTimeout(announce, 18_000);
  };
  agentProgressTimer = window.setTimeout(announce, 8_000);
}
function roleOf(params: any) {
  const text = JSON.stringify(params ?? {}).toLowerCase();
  return text.includes("research") ? "researcher" : text.includes("review") ? "reviewer" :
    text.includes("developer") || text.includes("commandexecution") || text.includes("filechange") ? "developer" : "orchestrator";
}
function drawWave() {
  const canvas = $("#wave") as HTMLCanvasElement, context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const time = performance.now() / 370, amplitude = 5 + state.level * 42 + (state.mode === "speaking" ? 22 : 0);
  context.beginPath();
  for (let x = 0; x <= canvas.width; x += 3) {
    const y = canvas.height / 2 + (Math.sin(x * .085 + time * 2.2) + Math.sin(x * .031 - time) * .55) * amplitude * Math.sin(x / canvas.width * Math.PI) * .48;
    x ? context.lineTo(x, y) : context.moveTo(x, y);
  }
  context.strokeStyle = state.mode === "working" ? "#ff9d2e" : state.mode === "stopped" ? "#ff3d33" : "#22c7ff";
  context.shadowColor = context.strokeStyle; context.shadowBlur = 15; context.lineWidth = 2; context.stroke();
  state.level *= .9; requestAnimationFrame(drawWave);
}
drawWave();

type VisualParticle = {
  fromX: number;
  fromY: number;
  burstX: number;
  burstY: number;
  targetX: number;
  targetY: number;
  size: number;
  phase: number;
  delay: number;
  curve: number;
  hairOffset: number;
  burstAngle: number;
  burstRadius: number;
  amber: boolean;
};

const particleCanvas = $("#particle-field") as HTMLCanvasElement;
const particleContext = particleCanvas.getContext("2d")!;
const characterImage = $("#jarvis-character") as HTMLImageElement;

let visualParticles: VisualParticle[] = [];
let formationStartedAt = -10_000;
let particleTargetBounds = { left: 0, top: 0, width: 1, height: 1 };
const FORMATION_DURATION = 4200;

function placeParticleOnHair(particle: VisualParticle) {
  const centerX = particleCanvas.width / 2;
  const centerY = particleCanvas.height / 2;
  const hairLength = Math.min(particleCanvas.width * .34, 460);
  const directionX = Math.cos(particle.burstAngle);
  const directionY = Math.sin(particle.burstAngle);
  particle.fromX = centerX + (particle.hairOffset - .5) * hairLength;
  particle.fromY = centerY + Math.sin(particle.phase * 1.7) * 5.5;
  particle.burstX = particle.fromX + directionX * particle.burstRadius;
  particle.burstY = particle.fromY + directionY * particle.burstRadius * .74;
}

function syncParticleCanvasSize() {
  const bounds = shell.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  if (particleCanvas.width !== width) particleCanvas.width = width;
  if (particleCanvas.height !== height) particleCanvas.height = height;
}

function prepareVisualParticles() {
  if (!characterImage.naturalWidth) return;
  syncParticleCanvasSize();
  const sample = document.createElement("canvas");
  sample.width = particleCanvas.width;
  sample.height = particleCanvas.height;
  const context = sample.getContext("2d", { willReadFrequently: true })!;
  const shellBounds = shell.getBoundingClientRect();
  const characterBounds = characterImage.getBoundingClientRect();
  const left = characterBounds.left - shellBounds.left;
  const top = characterBounds.top - shellBounds.top;
  particleTargetBounds = { left, top, width: characterBounds.width, height: characterBounds.height };
  context.drawImage(characterImage, left, top, characterBounds.width, characterBounds.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  visualParticles = [];
  for (let y = 0; y < sample.height; y += 7) {
    for (let x = 0; x < sample.width; x += 7) {
      const pixelIndex = (y * sample.width + x) * 4;
      const red = pixels[pixelIndex];
      const green = pixels[pixelIndex + 1];
      const blue = pixels[pixelIndex + 2];
      const alpha = pixels[pixelIndex + 3];
      const luminance = red * .2126 + green * .7152 + blue * .0722;
      if (alpha < 46 || luminance < 11 || Math.random() > .82) continue;
      const particle: VisualParticle = {
        fromX: 0,
        fromY: 0,
        burstX: 0,
        burstY: 0,
        targetX: x + (Math.random() - .5) * 5,
        targetY: y + (Math.random() - .5) * 5,
        size: Math.random() > .965 ? 2.6 + Math.random() * 1.8 : .45 + Math.random() * 1.65,
        phase: Math.random() * Math.PI * 2,
        delay: Math.random(),
        curve: (Math.random() - .5) * (90 + Math.random() * 190),
        hairOffset: Math.random(),
        burstAngle: Math.random() * Math.PI * 2,
        burstRadius: 46 + Math.random() * 230,
        amber: red > blue * 1.12 && red > green * 1.02 ? Math.random() < .58 : Math.random() < .1,
      };
      placeParticleOnHair(particle);
      visualParticles.push(particle);
    }
  }
}

function startParticleFormation() {
  if (!visualParticles.length) prepareVisualParticles();
  formationStartedAt = performance.now();
  for (const particle of visualParticles) placeParticleOnHair(particle);
}

function easeFormation(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function particlePosition(particle: VisualParticle, progress: number) {
  if (progress < .3) {
    const burstProgress = easeFormation(progress / .3);
    return {
      x: particle.fromX + (particle.burstX - particle.fromX) * burstProgress,
      y: particle.fromY + (particle.burstY - particle.fromY) * burstProgress,
    };
  }
  const eased = easeFormation((progress - .3) / .7);
  const deltaX = particle.targetX - particle.burstX;
  const deltaY = particle.targetY - particle.burstY;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const bend = Math.sin(eased * Math.PI) * particle.curve;
  return {
    x: particle.burstX + deltaX * eased - deltaY / distance * bend,
    y: particle.burstY + deltaY * eased + deltaX / distance * bend,
  };
}

function drawHairSplitEnergy(now: number, rawProgress: number) {
  if (rawProgress < .2 || rawProgress > .72) return;
  const progress = Math.max(0, Math.min(1, rawProgress));
  const centerX = particleTargetBounds.left + particleTargetBounds.width / 2;
  const centerY = particleTargetBounds.top + particleTargetBounds.height / 2;
  const charge = Math.max(0, Math.min(1, (progress - .2) / .2));
  const release = Math.max(0, Math.min(1, (progress - .38) / .3));
  const hairHalfLength = Math.min(particleCanvas.width * .17, 230);
  particleContext.save();
  particleContext.globalCompositeOperation = "lighter";
  const hairGradient = particleContext.createLinearGradient(
    centerX - hairHalfLength,
    centerY,
    centerX + hairHalfLength,
    centerY,
  );
  hairGradient.addColorStop(0, `rgba(34,199,255,${charge * (1 - release) * .12})`);
  hairGradient.addColorStop(.3, `rgba(34,199,255,${charge * (1 - release) * .9})`);
  hairGradient.addColorStop(.7, `rgba(255,155,47,${charge * (1 - release) * .92})`);
  hairGradient.addColorStop(1, `rgba(255,155,47,${charge * (1 - release) * .12})`);
  particleContext.beginPath();
  particleContext.moveTo(centerX - hairHalfLength, centerY);
  particleContext.quadraticCurveTo(centerX, centerY - 7, centerX + hairHalfLength, centerY);
  particleContext.strokeStyle = hairGradient;
  particleContext.shadowColor = release > .35 ? "#fff3cb" : "#22c7ff";
  particleContext.shadowBlur = 18 + charge * 34;
  particleContext.lineWidth = 1.2 + charge * 2.2;
  particleContext.stroke();

  if (release > 0) {
    const rayOpacity = Math.sin(release * Math.PI);
    for (let index = 0; index < 28; index += 1) {
      const angle = index * 2.399963229728653 + now / 2100;
      const inner = 12 + release * 24;
      const outer = inner + (45 + (index % 7) * 17) * release;
      const amber = index % 3 === 0;
      particleContext.beginPath();
      particleContext.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner * .72);
      particleContext.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer * .72);
      particleContext.strokeStyle = amber
        ? `rgba(255,174,61,${rayOpacity * .48})`
        : `rgba(91,221,255,${rayOpacity * .52})`;
      particleContext.lineWidth = index % 5 === 0 ? 1.5 : .7;
      particleContext.stroke();
    }
  }
  particleContext.restore();
}

function drawParticleField(now: number) {
  particleContext.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
  if (visualParticles.length) {
    const rawProgress = (now - formationStartedAt) / FORMATION_DURATION;
    const forming = rawProgress >= 0 && rawProgress < 1.08;
    const visualVoiceLevel = currentWindow ? remoteSpeechLevel : state.level;
    const idleStrength = state.mode === "speaking" ? .18 + visualVoiceLevel * .48 : state.mode === "working" ? .12 : .045;
    particleContext.globalCompositeOperation = "lighter";
    for (const particle of visualParticles) {
      const emissionStart = .3 + particle.delay * .19;
      const localRaw = forming ? (rawProgress - emissionStart) / (.94 - emissionStart) : 1;
      if (forming && localRaw < 0) continue;
      const progress = Math.max(0, Math.min(1, localRaw));
      const point = particlePosition(particle, progress);
      const previous = particlePosition(particle, Math.max(0, progress - (.035 + particle.size * .008)));
      const drift = forming ? 0 : Math.sin(now / 760 + particle.phase) * (1.1 + visualVoiceLevel * 3.2);
      const x = point.x + drift;
      const y = point.y + Math.cos(now / 830 + particle.phase) * (forming ? 0 : 1.4);
      const alpha = forming
        ? progress < .86
          ? .28 + Math.sin(progress * Math.PI) * .72
          : Math.max(0, (1 - progress) / .14) * .62
        : idleStrength;
      const color = state.mode === "working"
        ? "255,155,47"
        : state.mode === "stopped"
          ? "255,73,62"
          : particle.amber
            ? "255,155,47"
            : "34,199,255";
      if (forming) {
        particleContext.beginPath();
        particleContext.moveTo(previous.x, previous.y);
        particleContext.lineTo(x, y);
        particleContext.strokeStyle = `rgba(${color},${alpha * (particle.size > 2.5 ? .62 : .28)})`;
        particleContext.lineWidth = particle.size > 2.5 ? 1.5 : .65;
        particleContext.stroke();
      }
      particleContext.beginPath();
      particleContext.arc(x, y, particle.size * (forming ? 1.3 : 1), 0, Math.PI * 2);
      particleContext.fillStyle = `rgba(${color},${alpha})`;
      particleContext.fill();
    }
    if (forming) drawHairSplitEnergy(now, rawProgress);
    particleContext.globalCompositeOperation = "source-over";
  }
  requestAnimationFrame(drawParticleField);
}

if (characterImage.complete && characterImage.naturalWidth) prepareVisualParticles();
else characterImage.addEventListener("load", prepareVisualParticles, { once: true });
new ResizeObserver(() => prepareVisualParticles()).observe(shell);
requestAnimationFrame(drawParticleField);

function analyserLevel(analyser: AnalyserNode | null) {
  if (!analyser) return 0;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let energy = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    energy += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(energy / samples.length) * 5);
}

function updateAudioMeters() {
  if (!currentWindow) {
    const time = performance.now();
    state.level = state.mode === "speaking"
      ? .52 + Math.sin(time / 125) * .16
      : state.mode === "working"
        ? .2 + Math.sin(time / 310) * .08
        : state.mode === "listening"
          ? .08 + Math.sin(time / 430) * .035
          : 0;
    remoteSpeechLevel = state.mode === "speaking" ? state.level : 0;
    if (remoteSpeechLevel > .015) mouthHoldUntil = performance.now() + 140;
    shell.style.setProperty("--voice-pulse", String(1 + remoteSpeechLevel * .018));
    shell.style.setProperty("--voice-glow", String(.38 + remoteSpeechLevel * .46));
    updateMouthPose();
    requestAnimationFrame(updateAudioMeters);
    return;
  }
  const micLevel = analyserLevel(microphoneAnalyser);
  const envelopePositionMs = nativeVoicePlaybackActive
    ? performance.now() - nativeVoicePlaybackStartedAt
    : !voiceAudio.paused ? voiceAudio.currentTime * 1000 : -1;
  const envelopeIndex = localVoiceEnvelope && envelopePositionMs >= 0
    ? Math.min(
      localVoiceEnvelope.levels.length - 1,
      Math.floor(envelopePositionMs / localVoiceEnvelope.frameMs),
    )
    : -1;
  const envelopeLevel = envelopeIndex >= 0
    ? localVoiceEnvelope?.levels[envelopeIndex] ?? 0
    : 0;
  mouthShapeWidth = envelopeIndex >= 0
    ? localVoiceEnvelope?.widths[envelopeIndex] ?? 1
    : 1;
  mouthShapeHeight = envelopeIndex >= 0
    ? localVoiceEnvelope?.heights[envelopeIndex] ?? .72
    : .72;
  const speakerLevel = Math.max(analyserLevel(remoteAnalyser), envelopeLevel);
  remoteSpeechLevel += (speakerLevel - remoteSpeechLevel)
    * (speakerLevel > remoteSpeechLevel ? .52 : .24);
  if (speakerLevel < .008) remoteSpeechLevel *= .82;
  if (speakerLevel > .015) mouthHoldUntil = performance.now() + 140;
  state.level = Math.max(state.level, micLevel, speakerLevel);
  shell.style.setProperty("--voice-pulse", String(1 + remoteSpeechLevel * .018));
  shell.style.setProperty("--voice-glow", String(.38 + remoteSpeechLevel * .46));
  if (isVoicePlaybackActive()) {
    if (speakerLevel > 0.08 && state.mode !== "speaking") setMode("speaking");
  }
  updateMouthPose();
  requestAnimationFrame(updateAudioMeters);
}

function updateMouthPose() {
  const active = state.mode === "speaking" || performance.now() < mouthHoldUntil;
  const normalized = Math.max(0, Math.min(1, (remoteSpeechLevel - .006) / .24));
  const measured = active ? .08 + Math.pow(normalized, .72) * .74 : 0;
  let target = measured < .055 ? 0 : measured;
  if (Math.abs(target - mouthOpenness) < .025) target = mouthOpenness;
  mouthOpenness += (target - mouthOpenness) * (target > mouthOpenness ? .28 : .075);
  if (target === 0 && mouthOpenness < .018) mouthOpenness = 0;
  const widthTarget = active ? mouthShapeWidth : 1;
  const heightTarget = active ? mouthShapeHeight : .72;
  mouthWidth += (widthTarget - mouthWidth) * .36;
  mouthHeight += (heightTarget - mouthHeight) * .42;
  shell.style.setProperty("--mouth-open", mouthOpenness.toFixed(3));
  shell.style.setProperty("--mouth-width", mouthWidth.toFixed(3));
  shell.style.setProperty("--mouth-height", mouthHeight.toFixed(3));
}
updateAudioMeters();

function updateVoiceInfo(info: DirectVoice) {
  state.directVoice = info;
  mic.classList.toggle("active", info.voiceActive);
  $("#voice-auth").textContent = info.codexConnected
    ? `${info.protocol} · ${info.voiceActive ? "connected" : info.phase}`
    : `${info.protocol} · standby`;
  if (info.threadId) {
    state.session = { threadId: info.threadId, cwd: workspace };
    $("#thread-id").textContent = info.threadId;
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, info.threadId);
  }
}

async function handle(message: Message) {
  if (message.id !== undefined && message.method) {
    triggerCharacterAction("approval", 1800);
    approvalId = message.id; $("#approval-copy").textContent = `Codex 请求：${message.method}`; approval.showModal(); return;
  }
  const method = message.method, params = message.params;
  if (method === "thread/realtime/sdp") {
    if (!peer || !params?.sdp) return;
    try {
      await peer.setRemoteDescription({ type: "answer", sdp: params.sdp });
    } catch (error) {
      triggerCharacterAction("error");
      setMode("degraded");
      response.textContent = `Codex Voice SDP 连接失败：${String(error)}`;
    }
  } else if (method === "thread/realtime/started") {
    codexUsageLimitActive = false;
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: true,
      phase: "connected",
      protocol: "Codex · Wukong 本地克隆声线",
      threadId: params?.threadId,
      realtimeSessionId: params?.realtimeSessionId,
    });
    banner.hidden = true;
    setMode("listening");
    triggerCharacterAction("acknowledge");
    setWorker("orchestrator", "Local cloned voice ready");
    response.textContent = "Codex 已上线。Wukong 本地声线会回答每一句话。";
    scheduleWakeGreeting();
  } else if (method === "thread/realtime/transcript/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    if (params?.role === "assistant") {
      assistantTranscriptBuffer += delta;
      response.textContent = assistantTranscriptBuffer;
      pushLocalVoiceDelta(delta);
      if (state.mode !== "speaking") setMode("working");
    } else {
      if (!userTranscriptBuffer && delta) cancelLocalVoice(true);
      userTranscriptBuffer += delta;
      transcript.textContent = userTranscriptBuffer;
      setMode("listening");
    }
  } else if (method === "thread/realtime/transcript/done") {
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    if (params?.role === "assistant") {
      if (text) {
        response.textContent = text;
        finishLocalVoiceStream(text);
      }
      assistantTranscriptBuffer = "";
      if (!localSpeechPlaying && !isVoicePlaybackActive()) {
        setMode("listening");
      }
    } else {
      if (text) transcript.textContent = text;
      userTranscriptBuffer = "";
      if (text) triggerCharacterAction("acknowledge");
    }
  } else if (method === "thread/realtime/itemAdded") {
    const itemType = String(params?.item?.type ?? "");
    if (itemType.includes("handoff") || itemType.includes("delegation")) {
      setMode("working");
      setWorker("orchestrator", "Delegating to Codex");
    }
  } else if (method === "thread/realtime/error") {
    const detail = String(params?.message ?? "Codex Voice realtime error");
    // Session tuning is optional. Codex Realtime versions do not all accept
    // the same session.update fields, so a rejected tuning field must never
    // tear down an otherwise healthy voice conversation.
    if (/Unknown parameter:\s*['"]session\./i.test(detail)) {
      banner.hidden = true;
      response.textContent = "语音连接已使用兼容设置，继续说话即可。";
      return;
    }
    const usageLimit = isCodexUsageLimitError(detail);
    if (usageLimit) cleanupPeer(true);
    showRuntimeFailure(detail);
  } else if (method === "thread/realtime/closed") {
    cleanupPeer(codexUsageLimitActive);
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: false,
      phase: "closed",
      protocol: "Codex · Wukong 本地克隆声线",
      threadId: params?.threadId ?? state.session?.threadId,
    });
    if (!state.manualStop) {
      setMode("ready");
      response.textContent = "Codex Voice 已结束。再次说“嗨 悟空”即可唤醒。";
      await armWakeListener();
    }
  } else if (method === "turn/started") {
    if (state.manualStop) return;
    if (!state.directVoice?.voiceActive && !codexConversationMode) cancelLocalVoice(true);
    agentMessageBuffer = "";
    if (codexConversationMode) codexConversationBusy = true;
    state.agentWorking = true;
    scheduleAgentProgressNotices();
    setMode("working"); setWorker("orchestrator", "Codex working");
  } else if (method === "item/agentMessage/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    agentMessageBuffer += delta;
    if (agentMessageBuffer) response.textContent = agentMessageBuffer;
    if (codexConversationMode) pushLocalVoiceDelta(delta);
  } else if (method === "turn/completed") {
    state.agentWorking = false;
    stopAgentProgressNotices();
    const turnFailure = params?.turn?.error ?? params?.error;
    const turnFailed = params?.turn?.status === "failed" || Boolean(turnFailure);
    if (codexConversationMode && turnFailed) {
      codexConversationBusy = false;
      const detail = turnFailure ?? params;
      await endConversationAfterOnlineFailure(detail);
      return;
    }
    if (codexConversationMode) codexConversationBusy = false;
    if (!state.manualStop) triggerCharacterAction("complete", 1400);
    setMode(state.manualStop
      ? "stopped"
      : codexConversationMode ? "listening"
        : state.directVoice?.voiceActive ? "listening" : "ready");
    setWorker("orchestrator", state.manualStop ? "Interrupted" : "Ready", !state.manualStop);
    for (const role of ["developer", "researcher", "reviewer"]) {
      setWorker(role, state.manualStop ? "Interrupted" : "Standby", false);
    }
  } else if (method === "item/started") {
    if (!state.manualStop) setWorker(roleOf(params), "Working");
  }
  else if (method === "item/completed") {
    setWorker(roleOf(params), "Complete", false);
    if (params?.item?.type === "agentMessage") {
      const text = typeof params.item.text === "string" ? params.item.text : agentMessageBuffer;
      if (text) {
        response.textContent = text;
        if (codexConversationMode) finishLocalVoiceStream(text);
        else queueLocalVoice(text, 120);
      }
    }
  }
}

async function waitForIceGathering(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", changed);
      reject(new Error("WebRTC ICE gathering timed out"));
    }, 12_000);
    const changed = () => {
      if (connection.iceGatheringState !== "complete") return;
      window.clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    connection.addEventListener("icegatheringstatechange", changed);
  });
}

function attachAnalyser(stream: MediaStream, target: "microphone" | "remote") {
  audioContext ??= new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  if (target === "microphone") microphoneAnalyser = analyser;
  else remoteAnalyser = analyser;
}

function warmLocalVoice() {
  if (!currentWindow) return Promise.resolve({
    configured: true,
    ready: true,
    provider: "Preview",
    modelId: "preview",
    voiceName: "Preview",
    referenceAudio: "preview.wav",
  });
  localVoiceWarmup ??= invoke<LocalVoiceStatus>("prepare_local_voice")
    .then((status) => {
      $("#voice-auth").textContent = `${status.provider} · 本地声线就绪`;
      $("#local-voice-setup-status").textContent =
        `${status.voiceName} · ${status.modelId.split("/").at(-1)} · 首次加载 ${Math.max(0.1, (status.loadMs ?? 0) / 1000).toFixed(1)}s`;
      return status;
    })
    .catch((error) => {
      localVoiceWarmup = null;
      $("#voice-auth").textContent = `本地声线启动失败：${runtimeErrorText(error)}`;
      throw error;
    });
  return localVoiceWarmup;
}

async function ensureCodexConversationSession() {
  if (state.session) return state.session;
  state.session = await invoke<Session>("start_jarvis", {
    cwd: workspace,
    threadId: savedThreadId(),
    permissionMode,
  });
  localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, state.session.threadId);
  $("#thread-id").textContent = state.session.threadId;
  $("#workspace").textContent = state.session.cwd;
  return state.session;
}

async function startCodexConversationListener() {
  if (!currentWindow || !codexConversationMode || codexConversationBusy
    || codexConversationListening
    || localSpeechPlaying || localSpeechGenerating || localSpeechScheduleTimer !== undefined
    || localSpeechTextQueue.length || localSpeechAudioQueue.length || isVoicePlaybackActive()) return;
  codexConversationListening = true;
  try {
    await invoke("start_local_fallback_listener");
    banner.hidden = true;
    setMode("listening");
    setWorker("orchestrator", "Local speech · Codex ready");
    response.textContent = "我在听。请直接说出你的问题。";
  } catch (error) {
    codexConversationListening = false;
    setMode("degraded");
    banner.hidden = false;
    degradedTitle.textContent = "本地语音识别启动失败";
    $("#degraded-copy").textContent = runtimeErrorText(error);
  }
}

async function activateCodexConversation() {
  if (!currentWindow || codexConversationMode) return;
  state.manualStop = false;
  codexUsageLimitActive = false;
  codexConversationMode = true;
  codexConversationListening = false;
  codexConversationBusy = false;
  cancelLocalVoice(true);
  await invoke("disarm_wake_listener");
  banner.hidden = true;
  setMode("voice-starting");
  setWorker("orchestrator", "Wukong voice awakening");
  response.textContent = "悟空正在现身…";
  try {
    await warmLocalVoice();
    // Prepare the ordinary Codex thread in parallel with the summon effect.
    // A startup failure is handled after the first utterance so the greeting
    // itself is never silenced by a network or account problem.
    void ensureCodexConversationSession().catch(() => undefined);
  } catch (error) {
    codexConversationMode = false;
    showRuntimeFailure(error);
    $("#local-voice-setup-status").textContent = runtimeErrorText(error);
    if (!settings.open) settings.showModal();
    await armWakeListener();
    return;
  }
  const remainingFormation = Math.max(
    0,
    formationStartedAt + FORMATION_DURATION - performance.now(),
  );
  if (wakeGreetingTimer !== undefined) window.clearTimeout(wakeGreetingTimer);
  wakeGreetingTimer = window.setTimeout(() => {
    wakeGreetingTimer = undefined;
    if (!codexConversationMode || state.manualStop) return;
    transcript.textContent = "“黑悟空”";
    response.textContent = "我在，你说。";
    triggerCharacterAction("acknowledge");
    queueLocalVoice("我在，你说。", 0);
  }, remainingFormation + 120);
}

async function endConversationAfterOnlineFailure(error: unknown) {
  codexConversationMode = false;
  codexConversationListening = false;
  codexConversationBusy = false;
  try { await invoke("stop_local_fallback_listener"); } catch { /* already stopped */ }
  showRuntimeFailure(error);
  await armWakeListener();
}

async function handleCodexConversationUtterance(text: string) {
  const spoken = text.trim();
  if (!codexConversationMode || !spoken || codexConversationBusy) return;
  codexConversationListening = false;
  codexConversationBusy = true;
  state.manualStop = false;
  transcript.textContent = spoken;
  response.textContent = "悟空正在思考…";
  setMode("working");
  setWorker("orchestrator", "Codex answering");
  try {
    await invoke("stop_local_fallback_listener");
    await ensureCodexConversationSession();
    await invoke("send_text", { text: spoken });
  } catch (error) {
    codexConversationBusy = false;
    await endConversationAfterOnlineFailure(error);
  }
}

function cleanLocalVoiceText(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " 代码内容已显示在屏幕上。 ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "链接已显示在屏幕上")
    .replace(/[`*_>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function enqueueLocalVoiceChunk(text: string, revision = localSpeechRevision) {
  const spokenText = cleanLocalVoiceText(text);
  if (!spokenText || state.manualStop || revision !== localSpeechRevision) return;
  const previous = localSpeechTextQueue.at(-1)?.text
    ?? localSpeechAudioQueue.at(-1)?.text;
  if (spokenText === previous) return;
  localSpeechTextQueue.push({ text: spokenText, revision });
  void drainLocalVoiceGenerationQueue();
}

function beginLocalVoiceStream() {
  cancelLocalVoice(true);
  localSpeechStreamActive = true;
}

function pushLocalVoiceDelta(delta: string) {
  if (!currentWindow || !delta || state.manualStop) return;
  if (!localSpeechStreamActive) beginLocalVoiceStream();
}

function finishLocalVoiceStream(finalText: string) {
  if (!currentWindow || state.manualStop) return;
  const cleanedFinal = cleanLocalVoiceText(finalText);
  const batchText = finalText.trim();
  if (!cleanedFinal || batchText === localSpeechBatchText) return;
  if (!localSpeechStreamActive) {
    beginLocalVoiceStream();
  }
  // Keep one stable cloned voice per assistant response. Independent synthesis
  // calls can drift in timbre even when they share the same reference audio.
  enqueueLocalVoiceChunk(cleanedFinal);
  localSpeechStreamActive = false;
  localSpeechBatchText = batchText;
  lastSpokenBatchText = localSpeechBatchText;
}

function queueLocalVoice(text: string, delay = 320) {
  const spokenText = text.trim();
  if (!currentWindow || !spokenText || state.manualStop) return;
  const now = Date.now();
  if (spokenText === lastSpokenBatchText && now - lastSpokenAt < 15_000) return;
  if (spokenText === localSpeechBatchText) return;
  if (localSpeechScheduleTimer !== undefined) window.clearTimeout(localSpeechScheduleTimer);
  localSpeechScheduleTimer = window.setTimeout(() => {
    localSpeechScheduleTimer = undefined;
    beginLocalVoiceStream();
    enqueueLocalVoiceChunk(spokenText);
    localSpeechStreamActive = false;
    localSpeechBatchText = spokenText;
    lastSpokenBatchText = spokenText;
  }, delay);
}

function resetLocalVoiceMouth() {
  remoteSpeechLevel = 0;
  mouthOpenness = 0;
  mouthWidth = 1;
  mouthHeight = .72;
  mouthShapeWidth = 1;
  mouthShapeHeight = .72;
  shell.style.setProperty("--mouth-open", "0");
  shell.style.setProperty("--mouth-width", "1");
  shell.style.setProperty("--mouth-height", ".72");
}

function isVoicePlaybackActive() {
  return nativeVoicePlaybackActive || !voiceAudio.paused;
}

function ensureVoiceAudioAnalyser() {
  audioContext ??= new AudioContext();
  if (!voiceAudioSource) {
    voiceAudioSource = audioContext.createMediaElementSource(voiceAudio);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    voiceAudioSource.connect(analyser);
    analyser.connect(audioContext.destination);
    remoteAnalyser = analyser;
  }
}

function releaseVoiceAudioSource() {
  voiceAudio.pause();
  voiceAudio.removeAttribute("src");
  if (voiceAudioBlobUrl) URL.revokeObjectURL(voiceAudioBlobUrl);
  voiceAudioBlobUrl = null;
  localVoiceEnvelope = null;
}

function buildPcmWavEnvelope(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 44
    || view.getUint32(0, false) !== 0x52494646
    || view.getUint32(8, false) !== 0x57415645) return null;
  let offset = 12;
  let channels = 1;
  let sampleRate = 24_000;
  let audioFormat = 1;
  let bitsPerSample = 16;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x666d7420 && chunkSize >= 16) {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 0x64617461) {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkSize, bytes.byteLength - dataOffset);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!dataOffset || audioFormat !== 1 || bitsPerSample !== 16 || channels < 1) return null;
  const frameMs = 20;
  const samplesPerFrame = Math.max(1, Math.round(sampleRate * frameMs / 1000));
  const frameBytes = samplesPerFrame * channels * 2;
  const frameCount = Math.ceil(dataSize / frameBytes);
  const rawEnergy = new Float32Array(frameCount);
  const rawCrossings = new Float32Array(frameCount);
  const levels = new Float32Array(frameCount);
  const widths = new Float32Array(frameCount);
  const heights = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = dataOffset + frame * frameBytes;
    const end = Math.min(dataOffset + dataSize, start + frameBytes);
    let energy = 0;
    let count = 0;
    let crossings = 0;
    let previous = 0;
    for (let position = start; position + 1 < end; position += channels * 2) {
      const sample = view.getInt16(position, true) / 32768;
      energy += sample * sample;
      if (count && ((sample >= 0) !== (previous >= 0))) crossings += 1;
      previous = sample;
      count += 1;
    }
    rawEnergy[frame] = Math.sqrt(energy / Math.max(1, count));
    rawCrossings[frame] = crossings / Math.max(1, count - 1);
  }
  const voicedEnergy = [...rawEnergy].filter((level) => level > .002).sort((a, b) => a - b);
  const percentile = (fraction: number, fallback: number) => voicedEnergy.length
    ? voicedEnergy[Math.min(voicedEnergy.length - 1, Math.floor(voicedEnergy.length * fraction))]
    : fallback;
  const noiseFloor = Math.max(.0025, percentile(.12, .004) * .72);
  const speechPeak = Math.max(noiseFloor + .02, percentile(.9, .18));
  let smoothed = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const normalized = Math.max(0, Math.min(1,
      (rawEnergy[frame] - noiseFloor) / (speechPeak - noiseFloor),
    ));
    smoothed += (normalized - smoothed) * (normalized > smoothed ? .68 : .34);
    const level = smoothed < .025 ? 0 : Math.pow(smoothed, .78);
    const consonant = Math.max(0, Math.min(1, rawCrossings[frame] / .16));
    // Energy controls jaw opening; the zero-crossing rate is a lightweight
    // vowel/consonant proxy. This keeps vowels broad and open while fricatives
    // become narrower instead of using the old unrelated sine-wave motion.
    levels[frame] = level;
    heights[frame] = level > 0 ? .72 + level * .5 : .72;
    widths[frame] = level > 0 ? 1.12 - consonant * .24 + level * .05 : 1;
  }
  return { levels, widths, heights, frameMs };
}

function cancelLocalVoice(stopPlayback = false) {
  if (localSpeechScheduleTimer !== undefined) window.clearTimeout(localSpeechScheduleTimer);
  localSpeechScheduleTimer = undefined;
  localSpeechRevision += 1;
  localSpeechTextQueue = [];
  localSpeechAudioQueue = [];
  localSpeechStreamJobs.clear();
  localSpeechStreamActive = false;
  localSpeechBatchText = "";
  if (stopPlayback) {
    nativeVoicePlaybackActive = false;
    localVoiceEnvelope = null;
    if (currentWindow) void invoke("stop_local_voice_playback").catch(() => undefined);
    voiceAudioCancelPlayback?.();
    voiceAudioCancelPlayback = null;
    releaseVoiceAudioSource();
    resetLocalVoiceMouth();
  }
}

async function drainLocalVoiceGenerationQueue() {
  if (localSpeechGenerating || state.manualStop) return;
  localSpeechGenerating = true;
  try {
    while (localSpeechTextQueue.length && !state.manualStop) {
      const job = localSpeechTextQueue.shift()!;
      if (job.revision !== localSpeechRevision) continue;
      setWorker("orchestrator", "Streaming local voice");
      const streamId = `${job.revision}-${++localSpeechStreamId}`;
      localSpeechStreamJobs.set(streamId, job);
      try {
        await invoke<LocalVoiceStreamSummary>("stream_local_voice", {
          text: job.text,
          streamId,
        });
      } catch (error) {
        if (job.revision !== localSpeechRevision || state.manualStop) continue;
        triggerCharacterAction("error");
        setMode("degraded");
        banner.hidden = false;
        const detail = `本地声线生成失败：${runtimeErrorText(error)}`;
        $("#degraded-copy").textContent = detail;
        response.textContent = detail;
      } finally {
        localSpeechStreamJobs.delete(streamId);
      }
    }
  } finally {
    localSpeechGenerating = false;
    if (localSpeechTextQueue.length && !state.manualStop) {
      void drainLocalVoiceGenerationQueue();
    } else if (codexConversationMode && !codexConversationBusy && !state.manualStop
      && localSpeechScheduleTimer === undefined
      && !localSpeechAudioQueue.length && !localSpeechPlaying) {
      void startCodexConversationListener();
    }
  }
}

async function playVoiceAudioInWebView(item: LocalSpeechAudio) {
  const response = await fetch(convertFileSrc(item.audio.path));
  if (!response.ok) throw new Error("本地声线音频读取失败");
  const bytes = await response.arrayBuffer();
  if (item.revision !== localSpeechRevision || state.manualStop) return;
  releaseVoiceAudioSource();
  localVoiceEnvelope = buildPcmWavEnvelope(bytes);
  ensureVoiceAudioAnalyser();
  if (audioContext?.state === "suspended") await audioContext.resume();
  voiceAudioBlobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  voiceAudio.src = voiceAudioBlobUrl;
  voiceAudio.load();
  setMode("speaking");
  setWorker(
    "orchestrator",
    `Wukong Local · ${Math.max(0.1, item.audio.generationMs / 1000).toFixed(1)}s`,
  );
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      voiceAudio.removeEventListener("ended", ended);
      voiceAudio.removeEventListener("error", failed);
      if (voiceAudioCancelPlayback === cancelled) voiceAudioCancelPlayback = null;
      if (error) reject(error);
      else resolve();
    };
    const ended = () => finish();
    const failed = () => finish(new Error("本地声线音频播放失败"));
    const cancelled = () => finish();
    voiceAudio.addEventListener("ended", ended, { once: true });
    voiceAudio.addEventListener("error", failed, { once: true });
    voiceAudioCancelPlayback = cancelled;
    void voiceAudio.play().catch((error) => finish(
      new Error(`系统阻止本地声线播放：${String(error)}`),
    ));
  });
  releaseVoiceAudioSource();
}

async function playLocalVoiceAudio(item: LocalSpeechAudio) {
  try {
    const response = await fetch(convertFileSrc(item.audio.path));
    if (response.ok) localVoiceEnvelope = buildPcmWavEnvelope(await response.arrayBuffer());
  } catch (error) {
    console.warn("local WAV lip-sync analysis failed", error);
    localVoiceEnvelope = null;
  }
  if (item.revision !== localSpeechRevision || state.manualStop) return;
  nativeVoicePlaybackStartedAt = performance.now();
  nativeVoicePlaybackActive = true;
  setMode("speaking");
  setWorker(
    "orchestrator",
    `Wukong Local · ${Math.max(0.1, item.audio.generationMs / 1000).toFixed(1)}s`,
  );
  try {
    await invoke("play_local_voice", { path: item.audio.path });
  } catch (nativeError) {
    nativeVoicePlaybackActive = false;
    if (item.revision !== localSpeechRevision || state.manualStop) return;
    console.warn("macOS native voice playback failed; using WebView fallback", nativeError);
    await playVoiceAudioInWebView(item);
  } finally {
    nativeVoicePlaybackActive = false;
    localVoiceEnvelope = null;
  }
}

async function drainLocalVoicePlaybackQueue() {
  if (localSpeechPlaying || state.manualStop) return;
  localSpeechPlaying = true;
  try {
    while (localSpeechAudioQueue.length && !state.manualStop) {
      const item = localSpeechAudioQueue.shift()!;
      if (item.revision !== localSpeechRevision) continue;
      lastSpokenText = item.text;
      lastSpokenAt = Date.now();
      await playLocalVoiceAudio(item);
    }
  } catch (error) {
    if (!state.manualStop) {
      triggerCharacterAction("error");
      setMode("degraded");
      response.textContent = String(error);
    }
  } finally {
    localSpeechPlaying = false;
    if (localSpeechAudioQueue.length && !state.manualStop) {
      void drainLocalVoicePlaybackQueue();
    } else if (!state.manualStop && !isVoicePlaybackActive()) {
      resetLocalVoiceMouth();
      if (codexConversationMode) {
        setMode("listening");
        setWorker("orchestrator", "Local speech · Codex ready", true);
        void startCodexConversationListener();
      } else {
        setMode(codexUsageLimitActive
          ? "degraded"
          : state.directVoice?.voiceActive ? "listening" : "ready");
        setWorker("orchestrator", localSpeechGenerating ? "Rendering next phrase" : "Ready", true);
      }
    }
  }
}

function cleanupPeer(preserveLocalVoice = false) {
  if (wakeGreetingTimer !== undefined) window.clearTimeout(wakeGreetingTimer);
  wakeGreetingTimer = undefined;
  wakeGreetingPending = false;
  realtimeEventsChannel?.close();
  realtimeEventsChannel = null;
  peer?.close();
  peer = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  remoteStream?.getTracks().forEach((track) => track.stop());
  remoteStream = null;
  if (!preserveLocalVoice) cancelLocalVoice(true);
  microphoneAnalyser = null;
  remoteAnalyser = null;
  remoteSpeechLevel = 0;
  mouthOpenness = 0;
  shell.style.setProperty("--mouth-open", "0");
}

function scheduleWakeGreeting() {
  if (!currentWindow || !wakeGreetingPending) return;
  if (wakeGreetingTimer !== undefined) window.clearTimeout(wakeGreetingTimer);
  const remainingFormation = Math.max(
    0,
    formationStartedAt + FORMATION_DURATION - performance.now(),
  );
  wakeGreetingTimer = window.setTimeout(async () => {
    wakeGreetingTimer = undefined;
    if (!wakeGreetingPending || !state.directVoice?.voiceActive) return;
    wakeGreetingPending = false;
    transcript.textContent = "“嗨，悟空”";
    try {
      // The local wake listener consumes the phrase before Voice exists.
      // Relay that same utterance once the portrait has fully materialized so
      // Jarvis answers the first call instead of waiting for a second one.
      await invoke("append_codex_voice_text", {
        text: "我刚才已经用唤醒词叫你出来了。现在直接用一句简短自然的话回应我，不要重复唤醒词，也不要解释流程。",
      });
    } catch (error) {
      response.textContent = `唤醒后自动应答失败：${String(error)}`;
    }
  }, remainingFormation + 120);
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function isNotAllowedError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "NotAllowedError"
    : String(error).includes("NotAllowedError");
}

async function acquireMicrophone(coldStart: boolean) {
  const attempts = coldStart ? 6 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      if (!coldStart || !isNotAllowedError(error) || attempt === attempts) throw error;
      response.textContent = `正在等待系统释放麦克风… ${attempt}/${attempts - 1}`;
      await sleep(700);
    }
  }
  throw new Error("麦克风初始化失败");
}

async function startDirectVoice({ coldStart = false } = {}) {
  if (!currentWindow) {
    setMode("voice-starting");
    window.setTimeout(() => setMode("listening"), FORMATION_DURATION);
    return;
  }
  if (voiceStartInFlight || peer || state.directVoice?.voiceActive) return;
  voiceStartInFlight = true;
  state.manualStop = false;
  codexUsageLimitActive = false;
  recoverableColdStartError = false;
  setMode("voice-starting");
  banner.hidden = true;
  response.textContent = "正在连接 Codex，并加载 Wukong 本地声线…";
  try {
    const microphoneAuthorization = await invoke<string>("request_microphone_permission");
    if (microphoneAuthorization !== "authorized") {
      throw new Error("请在系统设置 → 隐私与安全性 → 麦克风中允许 Wukong Codex。");
    }
    await invoke("disarm_wake_listener");
    void warmLocalVoice();
    if (coldStart) {
      // A newly created WKWebView can reject an otherwise-authorized
      // getUserMedia call until its first visible/focused render cycle.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await sleep(900);
    }
    microphoneStream = await acquireMicrophone(coldStart);
    attachAnalyser(microphoneStream, "microphone");

    const connection = new RTCPeerConnection();
    peer = connection;
    const track = microphoneStream.getAudioTracks()[0];
    if (!track) throw new Error("未找到麦克风音轨");
    connection.addTrack(track, microphoneStream);
    const eventsChannel = connection.createDataChannel("oai-events");
    realtimeEventsChannel = eventsChannel;
    eventsChannel.addEventListener("open", () => {
      if (peer !== connection || eventsChannel.readyState !== "open") return;
      // The Realtime default ends a turn after roughly half a second of
      // silence. Mandarin speakers naturally pause inside a sentence, which
      // previously created fragments such as "现在" and "但是" as separate,
      // billed turns. Wait through ordinary thinking pauses before replying.
      eventsChannel.send(JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 1400,
                create_response: true,
                interrupt_response: true,
              },
            },
          },
        },
      }));
    }, { once: true });
    connection.ontrack = (event) => {
      // Text modality should not contain assistant audio. Keep any unexpected
      // remote track muted so only the authorized local cloned voice is heard.
      remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      event.track.enabled = false;
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") {
        setMode("degraded");
        response.textContent = "Codex Voice WebRTC 连接失败。";
      }
    };
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection);
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error("WebRTC 未生成 SDP offer");

    const info = await invoke<DirectVoice>("start_codex_voice", {
      cwd: workspace,
      threadId: savedThreadId(),
      permissionMode,
      sdp,
    });
    updateVoiceInfo(info);
  } catch (error) {
    const usageLimit = isCodexUsageLimitError(error);
    cleanupPeer(usageLimit);
    recoverableColdStartError = coldStart && isNotAllowedError(error);
    showRuntimeFailure(error);
    if (!usageLimit) await armWakeListener();
  } finally {
    voiceStartInFlight = false;
  }
}

async function stopDirectVoice() {
  try {
    const info = await invoke<DirectVoice>("stop_codex_voice");
    updateVoiceInfo(info);
  } finally {
    cleanupPeer();
  }
}

if (currentWindow) {
  await listen<LocalVoiceStreamChunk>("local-voice-stream-chunk", ({ payload }) => {
    const job = localSpeechStreamJobs.get(payload.streamId);
    if (!job || job.revision !== localSpeechRevision || state.manualStop) return;
    localSpeechAudioQueue.push({
      ...job,
      audio: {
        path: payload.path,
        durationMs: payload.durationMs,
        generationMs: payload.generationMs,
      },
    });
    void drainLocalVoicePlaybackQueue();
  });
  await listen<Message>("codex-event", ({ payload }) => void handle(payload));
  await listen<boolean>("jarvis-manual-summon", () => {
    transcript.textContent = "“黑悟空”";
    state.manualStop = false;
    banner.hidden = true;
    void activateCodexConversation();
  });
  await listen<boolean>("jarvis-local-listener-ready", () => {
    if (!codexConversationMode) return;
    codexConversationListening = true;
    banner.hidden = true;
    setMode("listening");
    setWorker("orchestrator", "Local speech · Online Codex ready");
    response.textContent = "悟空正在听。请直接说出你的问题。";
  });
  await listen<LocalUtterance>("jarvis-local-utterance", ({ payload }) => {
    if (codexConversationMode) {
      codexConversationListening = false;
      void handleCodexConversationUtterance(payload.text);
    }
  });
  await listen<string>("jarvis-local-listener-error", ({ payload }) => {
    if (!codexConversationMode) return;
    codexConversationListening = false;
    setMode("degraded");
    response.textContent = `本地语音识别中断：${payload}`;
    window.setTimeout(() => void startCodexConversationListener(), 600);
  });
  await listen<WakeStatus>("jarvis-wake-status", ({ payload }) => {
    state.wake = payload;
    $("#wake-auth").textContent = payload.ready
      ? "Local listener ready"
      : payload.authorization === "authorized"
        ? "Waiting to re-arm"
        : payload.authorization;
    if (payload.ready) {
      if (recoverableColdStartError && state.mode === "degraded") {
        recoverableColdStartError = false;
        banner.hidden = true;
        setMode("ready");
      }
      if (state.mode === "ready") {
        response.textContent = "我在。直接说“嗨 悟空”。";
        setWorker("orchestrator", "Wake word armed");
      }
    }
  });
  await listen<WakeEvent>("jarvis-wake", ({ payload }) => {
    transcript.textContent = "“嗨，悟空”";
    state.manualStop = false;
    if (!payload.ok) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = payload.error ?? "无法打开官方 Codex Voice。";
      response.textContent = payload.error ?? "无法打开官方 Codex Voice。";
      return;
    }
    banner.hidden = true;
    void activateCodexConversation();
  });
}
$("#command-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = $("#command-input") as HTMLInputElement, text = input.value.trim();
  if (!text) return;
  state.manualStop = false;
  transcript.textContent = text;
  input.value = "";
  if (!currentWindow) {
    response.textContent = "视觉预览：文字任务已切换为 Codex 工作态。";
    setMode("working");
    return;
  }
  if (state.directVoice?.voiceActive) {
    response.textContent = "已将文字作为用户话语注入当前 Codex Voice 会话。";
    await invoke("append_codex_voice_text", { text });
    return;
  }
  if (codexConversationMode) {
    await handleCodexConversationUtterance(text);
    return;
  }
  await ensureCodexConversationSession();
  setMode("working");
  await invoke("send_text", { text });
});
mic.addEventListener("click", () => {
  if (codexConversationMode) {
    codexConversationMode = false;
    codexConversationListening = false;
    codexConversationBusy = false;
    void invoke("stop_local_fallback_listener").then(() => armWakeListener());
  } else void activateCodexConversation();
});
$("#stop").addEventListener("click", async () => {
  triggerCharacterAction("error", 700);
  state.manualStop = true; setMode("stopped");
  state.agentWorking = false;
  stopAgentProgressNotices();
  for (const role of ["orchestrator", "developer", "researcher", "reviewer"]) setWorker(role, "Interrupted", false);
  if (!currentWindow) return;
  if (codexConversationMode || codexConversationListening) {
    codexConversationMode = false;
    codexConversationListening = false;
    codexConversationBusy = false;
    try { await invoke("stop_local_fallback_listener"); } catch { /* already stopped */ }
  }
  if (state.directVoice?.voiceActive || peer) {
    try { await stopDirectVoice(); } catch { /* task interruption still continues */ }
  }
  await invoke("stop_all");
  await armWakeListener();
});
function syncPermissionControls() {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="permission-mode"][value="${permissionMode}"]`,
  );
  if (input) input.checked = true;
  $("#permission-mode-label").textContent = permissionLabels[permissionMode];
}

$("#settings").addEventListener("click", () => {
  syncPermissionControls();
  settings.showModal();
});
$("#reload-local-voice").addEventListener("click", async () => {
  const button = $("#reload-local-voice") as HTMLButtonElement;
  const setupStatus = $("#local-voice-setup-status");
  button.disabled = true;
  setupStatus.textContent = "正在本机加载 4bit 声线与 8月9日录音特征…";
  try {
    localVoiceWarmup = null;
    const status = await warmLocalVoice();
    $("#voice-auth").textContent = `${status.provider} · 本地声线就绪`;
    setupStatus.textContent = `加载完成：${status.voiceName} · 不调用付费语音 API`;
    state.manualStop = false;
    banner.hidden = true;
    response.textContent = "本地声线已经就绪。以后召唤我，我会用 8月9日录音的声线回答。";
    queueLocalVoice("本地声线已经就绪。以后召唤我，我会用这个声音回答。", 0);
  } catch (error) {
    setupStatus.textContent = runtimeErrorText(error);
    $("#voice-auth").textContent = "Wukong Local · 加载失败";
  } finally {
    button.disabled = false;
  }
});
$("#close-settings").addEventListener("click", () => settings.close());
$("#quit-app").addEventListener("click", async () => {
  response.textContent = "正在完全退出 Wukong Codex…";
  await invoke("quit_app");
});
document.addEventListener("keydown", (event) => {
  if (!currentWindow || !event.metaKey || event.key.toLowerCase() !== "q") return;
  event.preventDefault();
  void invoke("quit_app");
}, { capture: true });
$("#new-thread").addEventListener("click", async () => {
  const button = $("#new-thread") as HTMLButtonElement;
  button.disabled = true;
  state.manualStop = true;
  settings.close();
  response.textContent = "正在结束当前任务并创建新的 Codex thread…";
  try {
    if (state.directVoice?.voiceActive || peer) {
      try { await stopDirectVoice(); } catch { cleanupPeer(); }
    }
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    localVoiceWarmup = null;
    const freshSession = await invoke<Session>("start_jarvis", {
      cwd: workspace,
      threadId: null,
      permissionMode,
    });
    state.session = freshSession;
    state.directVoice = null;
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, freshSession.threadId);
    $("#thread-id").textContent = freshSession.threadId;
    $("#workspace").textContent = freshSession.cwd;
    userTranscriptBuffer = "";
    assistantTranscriptBuffer = "";
    agentMessageBuffer = "";
    transcript.textContent = "“新开线程”";
    response.textContent = "新的 Codex thread 已创建。下一次唤醒和文字任务都会进入这个线程。";
    setMode("ready");
    setWorker("orchestrator", "Fresh thread ready");
  } catch (error) {
    try { await invoke("shutdown"); } catch { /* already stopped */ }
    state.session = null;
    state.directVoice = null;
    setMode("degraded");
    response.textContent = `新建线程失败，原线程仍可续接：${String(error)}`;
  } finally {
    button.disabled = false;
    await armWakeListener();
  }
});
$("#save-settings").addEventListener("click", async () => {
  const nextWorkspace = ($("#workspace-setting") as HTMLInputElement).value.trim();
  if (!nextWorkspace) return;
  const selectedPermission = document.querySelector<HTMLInputElement>(
    'input[name="permission-mode"]:checked',
  )?.value as PermissionMode | undefined;
  const nextPermission = selectedPermission ?? permissionMode;
  if (nextWorkspace !== workspace) {
    localStorage.setItem(WORKSPACE_KEY, nextWorkspace);
    response.textContent = "工作目录已保存，重启 Jarvis 后生效。";
  }
  if (nextPermission !== permissionMode) {
    state.manualStop = true;
    if (state.directVoice?.voiceActive || peer) {
      try { await stopDirectVoice(); } catch { cleanupPeer(); }
    }
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    localVoiceWarmup = null;
    permissionMode = nextPermission;
    localStorage.setItem(PERMISSION_KEY, permissionMode);
    state.session = null;
    state.directVoice = null;
    syncPermissionControls();
    setMode("ready");
    response.textContent = `权限已切换为“${permissionLabels[permissionMode]}”，下一次任务将续接当前 Codex thread。`;
    await armWakeListener();
  }
  settings.close();
});
for (const [selector, approved] of [["#approve", true], ["#deny", false]] as const) {
  $(selector).addEventListener("click", async () => { await invoke("resolve_server_request", { requestId: approvalId, approved }); approval.close(); });
}

if (currentWindow) {
  try {
    workspace = localStorage.getItem(WORKSPACE_KEY)
      ?? await invoke<string>("default_workspace");
    localStorage.setItem(WORKSPACE_KEY, workspace);
    $("#thread-id").textContent = "Not started";
    $("#workspace").textContent = workspace;
    ($("#workspace-setting") as HTMLInputElement).value = workspace;
    syncPermissionControls();
    setWorker("orchestrator", "Wake word starting");
    setMode("ready");
    const voiceStatus = await invoke<LocalVoiceStatus>("local_voice_status");
    $("#voice-auth").textContent = voiceStatus.configured
      ? "Wukong Local · 正在加载"
      : "Wukong Local · 运行环境缺失";
    if (voiceStatus.configured) void warmLocalVoice().catch(() => undefined);
    const backgroundStart = await invoke<boolean>("startup_is_background");
    if (!backgroundStart) {
      const microphoneAuthorization = await invoke<string>("request_microphone_permission");
      if (microphoneAuthorization !== "authorized") {
        setMode("degraded");
        banner.hidden = false;
        $("#degraded-copy").textContent =
          "请在系统设置 → 隐私与安全性 → 麦克风中允许 Wukong Codex。";
      }
    }
    await armWakeListener();
    updateVoiceInfo(await invoke<DirectVoice>("direct_voice_status"));
    const coldWake = await invoke<boolean>("consume_cold_wake");
    if (coldWake) {
      transcript.textContent = "“嗨，悟空”";
    }
    if (!backgroundStart || coldWake) void activateCodexConversation();
  } catch (error) { setMode("stopped"); response.textContent = `启动失败：${String(error)}`; }
} else {
  workspace = "Visual preview · native systems disconnected";
  $("#thread-id").textContent = "Preview only";
  $("#workspace").textContent = workspace;
  ($("#workspace-setting") as HTMLInputElement).value = workspace;
  $("#wake-auth").textContent = "Preview · not connected";
  $("#voice-auth").textContent = "Preview · not connected";
  transcript.textContent = visualPreviewMode === "stopped" ? "“停下”" : "“嗨，悟空”";
  response.textContent = visualPreviewMode === "voice-starting"
    ? "正在从粒子中重构 Jarvis 核心…"
    : visualPreviewMode === "working"
      ? "Codex 正在执行任务，装甲能量切换为工作态。"
      : visualPreviewMode === "speaking"
        ? "语音输出正在驱动角色光效与声波。"
        : visualPreviewMode === "stopped"
          ? "所有任务已中断，等待下一次唤醒。"
          : "Jarvis 视觉系统预览就绪。";
  setMode(visualPreviewMode);
  if (["acknowledge", "approval", "complete", "error"].includes(previewActionValue ?? "")) {
    window.setTimeout(() => triggerCharacterAction(previewActionValue as CharacterAction, 1800), 180);
  }
  setWorker("orchestrator", visualPreviewMode === "working" ? "Codex working" : "Visual preview");
  if (visualPreviewMode === "working") {
    setWorker("developer", "Working");
  }
}

async function armWakeListener() {
  try {
    state.wake = await invoke<WakeStatus>("arm_wake_listener");
    $("#wake-auth").textContent = state.wake.ready ? "Local listener ready" : state.wake.authorization;
    if (["denied", "restricted"].includes(state.wake.authorization)) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = "请在系统设置 → 隐私与安全性中允许麦克风和语音识别。";
    }
  } catch (error) {
    $("#wake-auth").textContent = String(error);
  }
}
