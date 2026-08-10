use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, RwLock},
    time::{timeout, Duration},
};

#[cfg(target_os = "macos")]
const LOCAL_VOICE_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit";
#[cfg(target_os = "windows")]
const LOCAL_VOICE_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const LOCAL_VOICE_MODEL: &str = "unsupported";
const LOCAL_VOICE_NAME: &str = "Wukong · 8月9日本地声线";
const LOCAL_VOICE_REFERENCE_AUDIO: &str = "wukong-20260809-reference.wav";
const LOCAL_VOICE_REFERENCE_TEXT: &str = "wukong-20260809-reference-transcript.txt";
#[cfg(target_os = "macos")]
const LOCAL_VOICE_WORKER: &str = "voice_worker.py";
#[cfg(target_os = "windows")]
const LOCAL_VOICE_WORKER: &str = "voice_worker_windows.py";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const LOCAL_VOICE_WORKER: &str = "unsupported";
#[cfg(target_os = "macos")]
const LOCAL_VOICE_PROVIDER: &str = "Wukong Local MLX";
#[cfg(target_os = "windows")]
const LOCAL_VOICE_PROVIDER: &str = "Wukong Local Qwen / PyTorch";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const LOCAL_VOICE_PROVIDER: &str = "Unsupported";
// WebRTC/AVAS currently accepts Realtime V1 or V3, while text output requires
// V2. Therefore a microphone WebRTC session must use V3 + audio. Jarvis never
// selects a server voice and the frontend force-mutes the remote track. The
// assistant transcript is rendered through the user's authorized local clone.
const CODEX_WEBRTC_REALTIME_VERSION: &str = "v3";
const CODEX_WEBRTC_OUTPUT_MODALITY: &str = "audio";
const LOCAL_VOICE_TEXT_PROMPT: &str = "Reply in natural, concise Mandarin Chinese unless the user asks for another language. Begin with a self-contained spoken summary of at most 42 Chinese characters, then add screen-readable detail only when useful. Every assistant reply will be spoken aloud by the user's authorized local cloned voice, so prefer short conversational sentences, pronounceable wording, and minimal Markdown. Keep the Black Wukong character warm, capable, direct, and restrained; never imitate or claim to be a real actor, performer, or celebrity.";

struct AppState {
    runtime: Mutex<Option<Arc<CodexRuntime>>>,
    local_voice: Mutex<Option<Arc<LocalVoiceRuntime>>>,
    local_voice_playback_pid: AtomicU32,
    cold_wake_pending: AtomicBool,
    background_start: bool,
    wake_enabled: AtomicBool,
    wake_ready: AtomicBool,
    wake_supervisor_running: AtomicBool,
    wake_pid: AtomicU32,
    wake_authorization: RwLock<String>,
    local_fallback_enabled: AtomicBool,
    local_fallback_running: AtomicBool,
    local_fallback_pid: AtomicU32,
}

struct LocalVoiceRuntime {
    writer: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, LocalVoicePending>>,
    next_id: AtomicU64,
    load_ms: u64,
    pid_file: PathBuf,
}

struct LocalVoicePending {
    stream_id: String,
    sender: oneshot::Sender<Result<LocalVoiceStreamSummary, String>>,
}

#[tauri::command]
fn startup_is_background(state: State<'_, AppState>) -> bool {
    state.background_start
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use std::sync::Mutex as StdMutex;

    let media_type =
        unsafe { AVMediaTypeAudio }.ok_or_else(|| "macOS 未提供音频授权类型".to_owned())?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    match status {
        AVAuthorizationStatus::Authorized => return Ok("authorized".to_owned()),
        AVAuthorizationStatus::Denied => return Ok("denied".to_owned()),
        AVAuthorizationStatus::Restricted => return Ok("restricted".to_owned()),
        _ => {}
    }

    let (sender, receiver) = oneshot::channel::<bool>();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    {
        let completion_sender = sender.clone();
        let completion = RcBlock::new(move |granted: Bool| {
            if let Ok(mut guard) = completion_sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(granted.as_bool());
                }
            }
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &completion);
        }
    }
    let granted = receiver
        .await
        .map_err(|_| "macOS 麦克风授权回调中断".to_owned())?;
    Ok(if granted { "authorized" } else { "denied" }.to_owned())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    Ok("authorized".to_owned())
}

struct CodexRuntime {
    writer: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    thread_id: RwLock<Option<String>>,
    active_turn: RwLock<Option<String>>,
    voice_active: AtomicBool,
    voice_phase: RwLock<String>,
    realtime_session_id: RwLock<Option<String>>,
    permission_mode: PermissionMode,
    workspace: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PermissionMode {
    Safe,
    Auto,
    Full,
}

struct PermissionProfile {
    approval_policy: &'static str,
    sandbox: &'static str,
    instructions: &'static str,
}

impl PermissionMode {
    fn profile(self) -> PermissionProfile {
        match self {
            Self::Safe => PermissionProfile {
                approval_policy: "on-request",
                sandbox: "workspace-write",
                instructions: "Require explicit confirmation when Codex requests approval for actions outside the workspace boundary or for risky operations.",
            },
            Self::Auto => PermissionProfile {
                approval_policy: "never",
                sandbox: "workspace-write",
                instructions: "Work autonomously inside the selected workspace. Never request elevated access; if an action is blocked by the sandbox, explain the blocked boundary and continue with the safest in-workspace alternative.",
            },
            Self::Full => PermissionProfile {
                approval_policy: "never",
                sandbox: "danger-full-access",
                instructions: "Full filesystem and network access is enabled. Still avoid destructive or irreversible actions unless the user explicitly requested the exact action and target.",
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    thread_id: String,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectVoiceInfo {
    codex_connected: bool,
    voice_active: bool,
    phase: String,
    protocol: &'static str,
    thread_id: Option<String>,
    realtime_session_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeStatus {
    enabled: bool,
    ready: bool,
    authorization: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalVoiceStreamChunk {
    stream_id: String,
    path: String,
    duration_ms: u64,
    generation_ms: u64,
    chunk_index: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalVoiceStreamSummary {
    duration_ms: u64,
    generation_ms: u64,
    chunk_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalVoiceStatus {
    configured: bool,
    ready: bool,
    provider: &'static str,
    model_id: &'static str,
    voice_name: &'static str,
    reference_audio: String,
    load_ms: Option<u64>,
}

fn raise_jarvis_window(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;

            if let Some(mtm) = MainThreadMarker::new() {
                let application = NSApplication::sharedApplication(mtm);
                #[allow(deprecated)]
                application.activateIgnoringOtherApps(true);
            }
        }

        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            // A short floating interval lets macOS finish switching the
            // active application before the window returns to normal level.
            let _ = window.set_always_on_top(true);
            let _ = window.set_focus();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(700)).await;
                let _ = window.set_always_on_top(false);
            });
        }
    });
}

impl CodexRuntime {
    async fn spawn(
        app: AppHandle,
        permission_mode: PermissionMode,
        workspace: String,
    ) -> Result<Arc<Self>, String> {
        let codex_binary = codex_binary_path(&app)?;
        let mut codex_command = codex_app_server_command(&codex_binary);
        let mut child = codex_command
            // Realtime is an experimental app-server surface. Enable it only
            // for this isolated Jarvis child; never mutate ~/.codex/config.toml.
            .args(["app-server", "--enable", "realtime_conversation", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("无法启动 codex app-server：{error}"))?;
        let writer = child.stdin.take().ok_or("无法连接 Codex stdin")?;
        let stdout = child.stdout.take().ok_or("无法连接 Codex stdout")?;
        let stderr = child.stderr.take().ok_or("无法连接 Codex stderr")?;
        let runtime = Arc::new(Self {
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            thread_id: RwLock::new(None),
            active_turn: RwLock::new(None),
            voice_active: AtomicBool::new(false),
            voice_phase: RwLock::new("standby".to_owned()),
            realtime_session_id: RwLock::new(None),
            permission_mode,
            workspace,
        });

        let weak = Arc::downgrade(&runtime);
        let event_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                eprintln!(
                    "codex rpc: id={} method={}",
                    message
                        .get("id")
                        .map(Value::to_string)
                        .unwrap_or_else(|| "-".to_owned()),
                    message.get("method").and_then(Value::as_str).unwrap_or("-")
                );
                if message.get("method").is_none() {
                    if let Some(id) = message.get("id").and_then(Value::as_u64) {
                        if let Some(runtime) = weak.upgrade() {
                            if let Some(sender) = runtime.pending.lock().await.remove(&id) {
                                let result = if let Some(error) = message.get("error") {
                                    Err(error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("Codex request failed")
                                        .to_owned())
                                } else {
                                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                                };
                                let _ = sender.send(result);
                            }
                        }
                    }
                    continue;
                }
                if let Some(runtime) = weak.upgrade() {
                    match message.get("method").and_then(Value::as_str) {
                        Some("turn/started") => {
                            *runtime.active_turn.write().await = message
                                .pointer("/params/turn/id")
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                        }
                        Some("turn/completed") => *runtime.active_turn.write().await = None,
                        Some("thread/realtime/started") => {
                            runtime.voice_active.store(true, Ordering::SeqCst);
                            *runtime.voice_phase.write().await = "connected".to_owned();
                            *runtime.realtime_session_id.write().await = message
                                .pointer("/params/realtimeSessionId")
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                        }
                        Some("thread/realtime/error") => {
                            runtime.voice_active.store(false, Ordering::SeqCst);
                            *runtime.voice_phase.write().await = "error".to_owned();
                        }
                        Some("thread/realtime/closed") => {
                            runtime.voice_active.store(false, Ordering::SeqCst);
                            *runtime.voice_phase.write().await = "closed".to_owned();
                            *runtime.realtime_session_id.write().await = None;
                        }
                        _ => {}
                    }
                }
                let _ = event_app.emit("codex-event", message);
            }
        });
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("codex stderr: {line}");
                if line.contains("ERROR") {
                    let _ = app.emit("codex-diagnostic", line);
                }
            }
        });
        Ok(runtime)
    }

    async fn write(&self, message: &Value) -> Result<(), String> {
        let mut payload = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        payload.push(b'\n');
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&payload)
            .await
            .map_err(|error| error.to_string())?;
        writer.flush().await.map_err(|error| error.to_string())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write(&json!({"id": id, "method": method, "params": params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        timeout(Duration::from_secs(90), receiver)
            .await
            .map_err(|_| format!("{method} 响应超时"))?
            .map_err(|_| format!("{method} 响应通道关闭"))?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({"method": method, "params": params}))
            .await
    }

    async fn thread(&self) -> Result<String, String> {
        self.thread_id
            .read()
            .await
            .clone()
            .ok_or("Jarvis 尚未连接 Codex 线程".to_owned())
    }
}

fn local_voice_python(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(configured) = std::env::var("WUKONG_VOICE_PYTHON") {
        candidates.push(PathBuf::from(configured));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        #[cfg(target_os = "macos")]
        candidates.push(resource_dir.join("voice-runtime/bin/python3"));
        #[cfg(target_os = "windows")]
        candidates.push(resource_dir.join("voice-runtime/python.exe"));
    }
    if let Some(workspace) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        #[cfg(target_os = "macos")]
        candidates.push(workspace.join(".venv-voice/bin/python"));
        #[cfg(target_os = "windows")]
        candidates.push(workspace.join(".venv-voice/Scripts/python.exe"));
    }
    #[cfg(target_os = "macos")]
    if let Ok(data_home) = std::env::var("HOME") {
        candidates.push(
            PathBuf::from(data_home)
                .join("Library/Application Support/Wukong Codex/voice-runtime/bin/python"),
        );
    }
    #[cfg(target_os = "windows")]
    if let Ok(local_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local_data).join("Wukong Codex/voice-runtime/python.exe"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "本地声线运行环境缺失；请重新安装完整版 Wukong Codex。".to_owned())
}

fn local_voice_resource(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("voice-worker").join(name));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("voice-worker")
            .join(name),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("本地声线资源缺失：{name}"))
}

fn local_voice_output_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法读取程序数据目录：{error}"))?
        .join("local-voice/generated");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("无法创建本地声线缓存目录：{error}"))?;
    Ok(output_dir)
}

fn local_voice_pid_file(app: &AppHandle) -> Result<PathBuf, String> {
    let runtime_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法读取程序数据目录：{error}"))?
        .join("local-voice");
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| format!("无法创建本地声线运行目录：{error}"))?;
    Ok(runtime_dir.join("worker.pid"))
}

#[cfg(target_os = "macos")]
fn stop_stale_local_voice_worker(pid_file: &Path) {
    let Some(pid) = fs::read_to_string(pid_file)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 1)
    else {
        let _ = fs::remove_file(pid_file);
        return;
    };
    let pid_text = pid.to_string();
    let command = StdCommand::new("/bin/ps")
        .args(["-p", &pid_text, "-o", "command="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    if command.contains("voice_worker.py") && command.contains(LOCAL_VOICE_MODEL) {
        let _ = StdCommand::new("/bin/kill")
            .args(["-TERM", &pid_text])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = fs::remove_file(pid_file);
}

#[cfg(not(target_os = "macos"))]
fn stop_stale_local_voice_worker(pid_file: &Path) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = fs::read_to_string(pid_file)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 1)
    {
        let script = format!(
            "$p=Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*voice_worker_windows.py*') {{ Stop-Process -Id {pid} -Force }}"
        );
        let _ = StdCommand::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = fs::remove_file(pid_file);
}

impl LocalVoiceRuntime {
    async fn spawn(app: &AppHandle) -> Result<Arc<Self>, String> {
        let python = local_voice_python(app)?;
        let worker = local_voice_resource(app, LOCAL_VOICE_WORKER)?;
        let reference_audio = local_voice_resource(app, LOCAL_VOICE_REFERENCE_AUDIO)?;
        let reference_text = local_voice_resource(app, LOCAL_VOICE_REFERENCE_TEXT)?;
        let output_dir = local_voice_output_dir(app)?;
        let pid_file = local_voice_pid_file(app)?;
        stop_stale_local_voice_worker(&pid_file);

        let mut command = Command::new(python);
        command
            .arg(worker)
            .args(["--model", LOCAL_VOICE_MODEL, "--reference-audio"])
            .arg(reference_audio)
            .arg("--reference-text")
            .arg(reference_text)
            .arg("--output-dir")
            .arg(output_dir)
            .env("HF_HUB_DISABLE_TELEMETRY", "1")
            .env("TOKENIZERS_PARALLELISM", "false")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动本地声线：{error}"))?;
        let worker_pid = child.id().ok_or("本地声线没有返回进程编号")?;
        fs::write(&pid_file, worker_pid.to_string())
            .map_err(|error| format!("无法记录本地声线进程：{error}"))?;
        let writer = child.stdin.take().ok_or("本地声线输入通道不可用")?;
        let stdout = child.stdout.take().ok_or("本地声线输出通道不可用")?;
        let stderr = child.stderr.take().ok_or("本地声线诊断通道不可用")?;
        let mut lines = BufReader::new(stdout).lines();

        let diagnostic_app = app.clone();
        tokio::spawn(async move {
            let mut diagnostics = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = diagnostics.next_line().await {
                let _ = diagnostic_app.emit("local-voice-diagnostic", line);
            }
        });

        let ready = timeout(Duration::from_secs(900), async {
            loop {
                let line = lines
                    .next_line()
                    .await
                    .map_err(|error| format!("本地声线启动输出损坏：{error}"))?
                    .ok_or("本地声线在准备完成前退出")?;
                let value: Value = serde_json::from_str(&line)
                    .map_err(|error| format!("本地声线启动响应无效：{error}"))?;
                if value.get("type").and_then(Value::as_str) == Some("ready") {
                    return Ok::<Value, String>(value);
                }
            }
        })
        .await
        .map_err(|_| "本地声线首次加载超时；Windows 首次使用需下载开源 Qwen 模型。".to_owned())??;

        let runtime = Arc::new(Self {
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            load_ms: ready.get("loadMs").and_then(Value::as_u64).unwrap_or(0),
            pid_file,
        });
        let event_runtime = runtime.clone();
        let event_app = app.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    let _ = event_app.emit("local-voice-diagnostic", "本地声线返回了无效数据");
                    continue;
                };
                let Some(request_id) = value.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                match value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "chunk" => {
                        let stream_id = event_runtime
                            .pending
                            .lock()
                            .await
                            .get(&request_id)
                            .map(|pending| pending.stream_id.clone());
                        if let Some(stream_id) = stream_id {
                            let _ = event_app.emit(
                                "local-voice-stream-chunk",
                                LocalVoiceStreamChunk {
                                    stream_id,
                                    path: value
                                        .get("path")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned(),
                                    duration_ms: value
                                        .get("durationMs")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(0),
                                    generation_ms: value
                                        .get("generationMs")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(0),
                                    chunk_index: value
                                        .get("chunkIndex")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(0),
                                },
                            );
                        }
                    }
                    "result" => {
                        if let Some(pending) =
                            event_runtime.pending.lock().await.remove(&request_id)
                        {
                            let _ = pending.sender.send(Ok(LocalVoiceStreamSummary {
                                duration_ms: value
                                    .get("durationMs")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0),
                                generation_ms: value
                                    .get("generationMs")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0),
                                chunk_count: value
                                    .get("chunkCount")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0),
                            }));
                        }
                    }
                    "error" => {
                        if let Some(pending) =
                            event_runtime.pending.lock().await.remove(&request_id)
                        {
                            let message = value
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("本地声线生成失败")
                                .to_owned();
                            let _ = pending.sender.send(Err(message));
                        }
                    }
                    _ => {}
                }
            }
            let mut pending = event_runtime.pending.lock().await;
            for (_, request) in std::mem::take(&mut *pending) {
                let _ = request.sender.send(Err("本地声线进程已退出".to_owned()));
            }
            let _ = fs::remove_file(&event_runtime.pid_file);
        });
        Ok(runtime)
    }

    async fn synthesize(
        &self,
        text: String,
        stream_id: String,
    ) -> Result<LocalVoiceStreamSummary, String> {
        let request_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(request_id, LocalVoicePending { stream_id, sender });
        let mut payload = serde_json::to_vec(&json!({
            "id": request_id,
            "type": "synthesize",
            "text": text
        }))
        .map_err(|error| format!("无法准备本地声线请求：{error}"))?;
        payload.push(b'\n');
        if let Err(error) = self.writer.lock().await.write_all(&payload).await {
            self.pending.lock().await.remove(&request_id);
            return Err(format!("无法发送本地声线请求：{error}"));
        }
        match timeout(Duration::from_secs(120), receiver).await {
            Ok(result) => result.map_err(|_| "本地声线响应通道关闭".to_owned())?,
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                Err("本地声线生成超时".to_owned())
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn codex_app_server_command(path: &Path) -> Command {
    if matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("cmd" | "bat")
    ) {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C"]).arg(path);
        command
    } else {
        Command::new(path)
    }
}

#[cfg(not(target_os = "windows"))]
fn codex_app_server_command(path: &Path) -> Command {
    Command::new(path)
}

fn codex_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("JARVIS_CODEX_BIN") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("codex");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    candidates.extend([
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ]);
    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(app_data).join("npm/codex.cmd"));
        }
        if let Ok(output) = StdCommand::new("where.exe").arg("codex").output() {
            if output.status.success() {
                candidates.extend(
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .map(PathBuf::from),
                );
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".local/bin/codex"));
        candidates.push(PathBuf::from(home).join(".cargo/bin/codex"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "未找到 Codex 可执行文件；请安装 Codex，或设置 JARVIS_CODEX_BIN。".to_owned()
        })
}

async fn runtime(state: &State<'_, AppState>) -> Result<Arc<CodexRuntime>, String> {
    state
        .runtime
        .lock()
        .await
        .clone()
        .ok_or("Jarvis runtime 尚未启动".to_owned())
}

async fn direct_voice_info(state: &State<'_, AppState>) -> DirectVoiceInfo {
    let runtime = state.runtime.lock().await.clone();
    let Some(runtime) = runtime else {
        return DirectVoiceInfo {
            codex_connected: false,
            voice_active: false,
            phase: "standby".to_owned(),
            protocol: "Codex · Wukong 本地克隆声线",
            thread_id: None,
            realtime_session_id: None,
        };
    };
    let phase = runtime.voice_phase.read().await.clone();
    let thread_id = runtime.thread_id.read().await.clone();
    let realtime_session_id = runtime.realtime_session_id.read().await.clone();
    DirectVoiceInfo {
        codex_connected: true,
        voice_active: runtime.voice_active.load(Ordering::SeqCst),
        phase,
        protocol: "Codex · Wukong 本地克隆声线",
        thread_id,
        realtime_session_id,
    }
}

#[tauri::command]
async fn direct_voice_status(state: State<'_, AppState>) -> Result<DirectVoiceInfo, String> {
    Ok(direct_voice_info(&state).await)
}

#[tauri::command]
async fn local_voice_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LocalVoiceStatus, String> {
    let configured = local_voice_python(&app).is_ok()
        && local_voice_resource(&app, LOCAL_VOICE_WORKER).is_ok()
        && local_voice_resource(&app, LOCAL_VOICE_REFERENCE_AUDIO).is_ok()
        && local_voice_resource(&app, LOCAL_VOICE_REFERENCE_TEXT).is_ok();
    let runtime = state.local_voice.lock().await.clone();
    Ok(LocalVoiceStatus {
        configured,
        ready: runtime.is_some(),
        provider: LOCAL_VOICE_PROVIDER,
        model_id: LOCAL_VOICE_MODEL,
        voice_name: LOCAL_VOICE_NAME,
        reference_audio: LOCAL_VOICE_REFERENCE_AUDIO.to_owned(),
        load_ms: runtime.map(|value| value.load_ms),
    })
}

#[tauri::command]
async fn prepare_local_voice(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LocalVoiceStatus, String> {
    let runtime = {
        let existing = state.local_voice.lock().await.clone();
        if let Some(existing) = existing {
            existing
        } else {
            let started = LocalVoiceRuntime::spawn(&app).await?;
            *state.local_voice.lock().await = Some(started.clone());
            started
        }
    };
    Ok(LocalVoiceStatus {
        configured: true,
        ready: true,
        provider: LOCAL_VOICE_PROVIDER,
        model_id: LOCAL_VOICE_MODEL,
        voice_name: LOCAL_VOICE_NAME,
        reference_audio: LOCAL_VOICE_REFERENCE_AUDIO.to_owned(),
        load_ms: Some(runtime.load_ms),
    })
}

#[tauri::command]
async fn stream_local_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    stream_id: String,
) -> Result<LocalVoiceStreamSummary, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("本地声线文本不能为空".to_owned());
    }
    let runtime = {
        let existing = state.local_voice.lock().await.clone();
        if let Some(existing) = existing {
            existing
        } else {
            let started = LocalVoiceRuntime::spawn(&app).await?;
            *state.local_voice.lock().await = Some(started.clone());
            started
        }
    };
    runtime.synthesize(text.to_owned(), stream_id).await
}

fn stop_local_voice_process(state: &AppState) {
    let pid = state.local_voice_playback_pid.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = StdCommand::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = StdCommand::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[tauri::command]
async fn stop_local_voice_playback(state: State<'_, AppState>) -> Result<(), String> {
    stop_local_voice_process(&state);
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn play_local_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let allowed_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法读取程序数据目录：{error}"))?
        .join("local-voice/generated");
    let allowed_root = fs::canonicalize(&allowed_root)
        .map_err(|error| format!("无法读取本地声线缓存目录：{error}"))?;
    let audio_path = fs::canonicalize(PathBuf::from(path.trim()))
        .map_err(|error| format!("无法读取本地声线音频：{error}"))?;
    if !audio_path.starts_with(&allowed_root)
        || audio_path.extension().and_then(|value| value.to_str()) != Some("wav")
    {
        return Err("拒绝播放本地声线缓存目录以外的文件。".to_owned());
    }

    stop_local_voice_process(&state);
    let child = Command::new("/usr/bin/afplay")
        .arg(&audio_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 macOS 语音播放器：{error}"))?;
    let pid = child.id().ok_or("macOS 语音播放器没有返回进程编号。")?;
    state.local_voice_playback_pid.store(pid, Ordering::SeqCst);
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("macOS 语音播放中断：{error}"))?;
    let still_current = state
        .local_voice_playback_pid
        .compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    if output.status.success() || !still_current {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if detail.is_empty() {
        "macOS 系统播放器未能播放本地声线。".to_owned()
    } else {
        format!("macOS 系统播放器未能播放本地声线：{detail}")
    })
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn play_local_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let allowed_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法读取程序数据目录：{error}"))?
        .join("local-voice/generated");
    let allowed_root = fs::canonicalize(&allowed_root)
        .map_err(|error| format!("无法读取本地声线缓存目录：{error}"))?;
    let audio_path = fs::canonicalize(PathBuf::from(path.trim()))
        .map_err(|error| format!("无法读取本地声线音频：{error}"))?;
    if !audio_path.starts_with(&allowed_root)
        || audio_path.extension().and_then(|value| value.to_str()) != Some("wav")
    {
        return Err("拒绝播放本地声线缓存目录以外的文件。".to_owned());
    }

    stop_local_voice_process(&state);
    let script =
        "$player=New-Object System.Media.SoundPlayer $env:WUKONG_AUDIO_PATH; $player.PlaySync()";
    let child = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script,
        ])
        .env("WUKONG_AUDIO_PATH", &audio_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 Windows 语音播放器：{error}"))?;
    let pid = child.id().ok_or("Windows 语音播放器没有返回进程编号。")?;
    state.local_voice_playback_pid.store(pid, Ordering::SeqCst);
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("Windows 语音播放中断：{error}"))?;
    let still_current = state
        .local_voice_playback_pid
        .compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    if output.status.success() || !still_current {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if detail.is_empty() {
        "Windows 系统播放器未能播放本地声线。".to_owned()
    } else {
        format!("Windows 系统播放器未能播放本地声线：{detail}")
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
async fn play_local_voice(
    _app: AppHandle,
    _state: State<'_, AppState>,
    _path: String,
) -> Result<(), String> {
    Err("当前系统不支持原生本地声线播放。".to_owned())
}

fn wake_helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    let relative = PathBuf::from("wake-helper/JarvisWakeListener.app");
    #[cfg(target_os = "windows")]
    let relative = PathBuf::from("wake-helper-windows/WukongWakeListener.ps1");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let relative = PathBuf::from("wake-helper-unsupported");
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(&relative);
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    if development.exists() {
        return Ok(development);
    }
    Err("Wukong 唤醒监听器未找到".to_owned())
}

#[cfg(target_os = "macos")]
fn host_app_bundle_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let contents_dir = resource_dir.parent()?;
    let bundle = contents_dir.parent()?;
    (bundle.extension().and_then(|value| value.to_str()) == Some("app"))
        .then(|| bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn wake_listener_command(
    app: &AppHandle,
    helper: &Path,
    event_file: &Path,
    conversation: bool,
) -> Command {
    let mut command = Command::new("/usr/bin/open");
    command
        .args(["-n", "-W"])
        .arg(helper)
        .args(["--args", "--event-file"])
        .arg(event_file);
    if conversation {
        command.arg("--conversation");
    } else if let Some(host_app) = host_app_bundle_path(app) {
        command.arg("--host-app").arg(host_app);
    }
    command
}

#[cfg(target_os = "windows")]
fn wake_listener_command(
    _app: &AppHandle,
    helper: &Path,
    event_file: &Path,
    conversation: bool,
) -> Command {
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(helper)
        .arg("-EventFile")
        .arg(event_file);
    if conversation {
        command.arg("-Conversation");
    }
    command
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn wake_listener_command(
    _app: &AppHandle,
    helper: &Path,
    _event_file: &Path,
    _conversation: bool,
) -> Command {
    Command::new(helper)
}

async fn terminate_process(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(target_os = "macos")]
    let _ = Command::new("/bin/kill")
        .arg(pid.to_string())
        .status()
        .await;
    #[cfg(target_os = "windows")]
    let _ = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .await;
}

async fn kill_wake_helpers() {
    #[cfg(target_os = "macos")]
    let _ = Command::new("/usr/bin/pkill")
        .args(["-x", "JarvisWakeListener"])
        .status()
        .await;
    #[cfg(target_os = "windows")]
    {
        let script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*WukongWakeListener.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
        let _ = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .status()
            .await;
    }
}

async fn wake_status_value(state: &AppState) -> WakeStatus {
    WakeStatus {
        enabled: state.wake_enabled.load(Ordering::SeqCst),
        ready: state.wake_ready.load(Ordering::SeqCst),
        authorization: state.wake_authorization.read().await.clone(),
    }
}

fn start_wake_supervisor(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.wake_supervisor_running.swap(true, Ordering::SeqCst) {
        return;
    }
    state.wake_enabled.store(true, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let helper = match wake_helper_path(&app) {
            Ok(path) => path,
            Err(error) => {
                *state.wake_authorization.write().await = error.clone();
                state.wake_enabled.store(false, Ordering::SeqCst);
                state.wake_supervisor_running.store(false, Ordering::SeqCst);
                let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                return;
            }
        };
        // A previous host may have exited while its LaunchServices helper
        // remained alive. Keep exactly one microphone listener.
        kill_wake_helpers().await;

        let mut woke = false;
        while state.wake_enabled.load(Ordering::SeqCst) {
            state.wake_ready.store(false, Ordering::SeqCst);
            let event_file =
                std::env::temp_dir().join(format!("jarvis-wake-{}.jsonl", std::process::id()));
            let _ = fs::remove_file(&event_file);
            if let Err(error) = fs::write(&event_file, "") {
                *state.wake_authorization.write().await = format!("无法创建唤醒事件通道：{error}");
                break;
            }
            if !state.wake_enabled.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&event_file);
                break;
            }

            let mut command = wake_listener_command(&app, &helper, &event_file, false);
            let mut child = match command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(child) => child,
                Err(error) => {
                    *state.wake_authorization.write().await =
                        format!("无法启动唤醒监听器：{error}");
                    break;
                }
            };
            state
                .wake_pid
                .store(child.id().unwrap_or(0), Ordering::SeqCst);
            let mut processed = 0usize;

            loop {
                let content = fs::read_to_string(&event_file).unwrap_or_default();
                let lines: Vec<&str> = content.lines().collect();
                for line in lines.iter().skip(processed) {
                    let Ok(message) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    match message.get("type").and_then(Value::as_str) {
                        Some("authorization") => {
                            let authorization = message
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            *state.wake_authorization.write().await = authorization.to_owned();
                            // `notDetermined` means the helper has just asked
                            // macOS for access. Keep it alive so the native
                            // permission sheet can complete its callback.
                            if matches!(authorization, "denied" | "restricted") {
                                state.wake_enabled.store(false, Ordering::SeqCst);
                            }
                        }
                        Some("ready") => {
                            state.wake_ready.store(true, Ordering::SeqCst);
                        }
                        Some("wake") => {
                            woke = true;
                            state.wake_enabled.store(false, Ordering::SeqCst);
                            state.wake_ready.store(false, Ordering::SeqCst);
                            raise_jarvis_window(&app);
                        }
                        Some("error") => {
                            *state.wake_authorization.write().await = message
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("wake listener error")
                                .to_owned();
                        }
                        _ => {}
                    }
                    let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                    if woke {
                        break;
                    }
                }
                processed = lines.len();
                if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                    break;
                }
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }

            if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                kill_wake_helpers().await;
            }
            let _ = child.wait().await;
            let _ = fs::remove_file(&event_file);
            state.wake_pid.store(0, Ordering::SeqCst);
            if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        state.wake_ready.store(false, Ordering::SeqCst);
        state.wake_supervisor_running.store(false, Ordering::SeqCst);
        if woke {
            // The WebView owns the RTCPeerConnection, so wake only raises the
            // Jarvis surface and asks the renderer to begin the official Codex
            // app-server V3 Voice handshake. No keypress or UI automation.
            let _ = app.emit("jarvis-wake", json!({"ok": true}));
        }
        let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
    });
}

#[tauri::command]
async fn arm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    start_wake_supervisor(app.clone());
    tokio::time::sleep(Duration::from_millis(80)).await;
    Ok(wake_status_value(&app.state::<AppState>()).await)
}

#[tauri::command]
async fn disarm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    let state = app.state::<AppState>();
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    let pid = state.wake_pid.swap(0, Ordering::SeqCst);
    terminate_process(pid).await;
    // The supervisor starts asynchronously and can cross this command in
    // flight. Keep terminating until it has observed wake_enabled=false.
    for _ in 0..15 {
        kill_wake_helpers().await;
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // AVAudioEngine releases the input device asynchronously after SIGTERM.
    // Starting WebRTC in the same tick can otherwise fail with NotAllowedError.
    tokio::time::sleep(Duration::from_millis(350)).await;
    Ok(wake_status_value(&state).await)
}

#[tauri::command]
async fn wake_listener_status(app: AppHandle) -> WakeStatus {
    wake_status_value(&app.state::<AppState>()).await
}

#[tauri::command]
async fn start_local_fallback_listener(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.local_fallback_running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    state.local_fallback_enabled.store(true, Ordering::SeqCst);
    let helper = wake_helper_path(&app)?;
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let event_file = std::env::temp_dir().join(format!(
            "wukong-local-dialogue-{}.jsonl",
            std::process::id()
        ));
        let _ = fs::remove_file(&event_file);
        if let Err(error) = fs::write(&event_file, "") {
            let _ = app.emit(
                "jarvis-local-listener-error",
                format!("无法创建本地对话事件通道：{error}"),
            );
            state.local_fallback_running.store(false, Ordering::SeqCst);
            return;
        }
        let mut command = wake_listener_command(&app, &helper, &event_file, true);
        let mut child = match command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                let _ = app.emit(
                    "jarvis-local-listener-error",
                    format!("无法启动本地对话听写：{error}"),
                );
                state.local_fallback_running.store(false, Ordering::SeqCst);
                let _ = fs::remove_file(&event_file);
                return;
            }
        };
        state
            .local_fallback_pid
            .store(child.id().unwrap_or(0), Ordering::SeqCst);
        let mut processed = 0usize;
        let mut received = false;
        while state.local_fallback_enabled.load(Ordering::SeqCst) {
            let content = fs::read_to_string(&event_file).unwrap_or_default();
            let lines: Vec<&str> = content.lines().collect();
            for line in lines.iter().skip(processed) {
                let Ok(message) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                match message.get("type").and_then(Value::as_str) {
                    Some("ready") => {
                        let _ = app.emit("jarvis-local-listener-ready", true);
                    }
                    Some("utterance") => {
                        if let Some(text) = message.get("phrase").and_then(Value::as_str) {
                            received = true;
                            state.local_fallback_enabled.store(false, Ordering::SeqCst);
                            let _ =
                                app.emit("jarvis-local-utterance", json!({"text": text.trim()}));
                        }
                    }
                    Some("error") => {
                        let message = message
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("本地语音识别中断");
                        let _ = app.emit("jarvis-local-listener-error", message);
                    }
                    _ => {}
                }
                if received {
                    break;
                }
            }
            processed = lines.len();
            if received || !state.local_fallback_enabled.load(Ordering::SeqCst) {
                break;
            }
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if received || !state.local_fallback_enabled.load(Ordering::SeqCst) {
            kill_wake_helpers().await;
        }
        let _ = child.wait().await;
        state.local_fallback_pid.store(0, Ordering::SeqCst);
        state.local_fallback_running.store(false, Ordering::SeqCst);
        let _ = fs::remove_file(&event_file);
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    Ok(())
}

#[tauri::command]
async fn stop_local_fallback_listener(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.local_fallback_enabled.store(false, Ordering::SeqCst);
    let pid = state.local_fallback_pid.swap(0, Ordering::SeqCst);
    terminate_process(pid).await;
    kill_wake_helpers().await;
    for _ in 0..12 {
        if !state.local_fallback_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

#[tauri::command]
async fn consume_cold_wake(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if !state.cold_wake_pending.swap(false, Ordering::SeqCst) {
        return Ok(false);
    }
    // Replay a cold launch through the same external event path as a normal
    // warm wake, but only after the newly spawned listener fully releases mic.
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    let pid = state.wake_pid.swap(0, Ordering::SeqCst);
    terminate_process(pid).await;
    for _ in 0..15 {
        kill_wake_helpers().await;
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(350)).await;
    raise_jarvis_window(&app);
    let _ = app.emit("jarvis-wake", json!({"ok": true, "cold": true}));
    Ok(true)
}

#[tauri::command]
fn default_workspace() -> Result<String, String> {
    if let Ok(configured) = std::env::var("JARVIS_WORKSPACE") {
        let path = PathBuf::from(configured);
        if path.is_dir() {
            return path
                .canonicalize()
                .map(|value| value.to_string_lossy().into_owned())
                .map_err(|error| format!("无法读取 JARVIS_WORKSPACE：{error}"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let path = PathBuf::from(home);
        if path.is_dir() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    std::env::current_dir()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("无法确定默认工作目录：{error}"))
}

fn validated_workspace(cwd: &str) -> Result<String, String> {
    let path = PathBuf::from(cwd);
    if !path.is_dir() {
        return Err(format!("工作目录不存在或不是文件夹：{cwd}"));
    }
    path.canonicalize()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("无法读取工作目录：{error}"))
}

async fn terminate_runtime(state: &AppState) -> Result<(), String> {
    if let Some(runtime) = state.runtime.lock().await.take() {
        runtime
            .child
            .lock()
            .await
            .kill()
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn terminate_local_voice(state: &AppState) {
    let Some(runtime) = state.local_voice.lock().await.take() else {
        return;
    };
    if let Ok(mut payload) = serde_json::to_vec(&json!({"id": 0, "type": "stop"})) {
        payload.push(b'\n');
        let _ = runtime.writer.lock().await.write_all(&payload).await;
    }
    let mut child = runtime.child.lock().await;
    if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    let _ = fs::remove_file(&runtime.pid_file);
}

async fn ensure_runtime(
    app: AppHandle,
    state: &State<'_, AppState>,
    cwd: &str,
    resume_thread_id: Option<&str>,
    permission_mode: PermissionMode,
) -> Result<Arc<CodexRuntime>, String> {
    let cwd = validated_workspace(cwd)?;
    let existing = { state.runtime.lock().await.clone() };
    if let Some(existing) = existing {
        if existing.permission_mode == permission_mode && existing.workspace == cwd {
            return Ok(existing);
        }
        terminate_runtime(state).await?;
    }
    let profile = permission_mode.profile();
    let runtime = CodexRuntime::spawn(app, permission_mode, cwd.clone()).await?;
    runtime.request("initialize", json!({
        "clientInfo": {"name": "wukong-codex", "title": "Wukong Codex", "version": env!("CARGO_PKG_VERSION")},
        "capabilities": {"experimentalApi": true}
    })).await?;
    runtime.notify("initialized", json!({})).await?;
    let thread_options = json!({
        "cwd": cwd,
        "approvalPolicy": profile.approval_policy,
        "sandbox": profile.sandbox,
        "baseInstructions": format!(
            "You are Codex speaking through the local Wukong interface. Keep voice replies concise and natural, execute real tasks with Codex tools when asked, report progress while work continues, and accept spoken corrections in the same thread. {}",
            profile.instructions
        )
    });
    let started = if let Some(thread_id) = resume_thread_id.filter(|value| !value.trim().is_empty())
    {
        let mut resume_options = thread_options.clone();
        resume_options["threadId"] = Value::String(thread_id.to_owned());
        match runtime.request("thread/resume", resume_options).await {
            Ok(resumed) => resumed,
            Err(_) => {
                let mut start_options = thread_options;
                start_options["ephemeral"] = Value::Bool(false);
                runtime.request("thread/start", start_options).await?
            }
        }
    } else {
        let mut start_options = thread_options;
        start_options["ephemeral"] = Value::Bool(false);
        runtime.request("thread/start", start_options).await?
    };
    let thread_id = started
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or("Codex 未返回 threadId")?
        .to_owned();
    *runtime.thread_id.write().await = Some(thread_id.clone());
    *state.runtime.lock().await = Some(runtime.clone());
    Ok(runtime)
}

#[tauri::command]
async fn start_jarvis(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    thread_id: Option<String>,
    permission_mode: PermissionMode,
) -> Result<SessionInfo, String> {
    let runtime = ensure_runtime(app, &state, &cwd, thread_id.as_deref(), permission_mode).await?;
    let thread_id = runtime.thread().await?;
    Ok(SessionInfo { thread_id, cwd })
}

#[tauri::command]
async fn start_codex_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    thread_id: Option<String>,
    permission_mode: PermissionMode,
    sdp: String,
) -> Result<DirectVoiceInfo, String> {
    if !sdp.starts_with("v=0") {
        return Err("WebRTC SDP offer 无效".to_owned());
    }
    let runtime = ensure_runtime(app, &state, &cwd, thread_id.as_deref(), permission_mode).await?;
    let thread_id = runtime.thread().await?;
    if runtime.voice_active.load(Ordering::SeqCst) {
        let _ = runtime
            .request("thread/realtime/stop", json!({"threadId": thread_id}))
            .await;
    }
    *runtime.voice_phase.write().await = "starting".to_owned();
    runtime.voice_active.store(false, Ordering::SeqCst);
    *runtime.realtime_session_id.write().await = None;

    let params = json!({
        "threadId": thread_id,
        // WebRTC requires V3 audio, but Wukong never selects or plays a server
        // voice. The muted remote track supplies transcripts only; every
        // audible answer is synthesized by the user's local cloned voice.
        "outputModality": CODEX_WEBRTC_OUTPUT_MODALITY,
        "version": CODEX_WEBRTC_REALTIME_VERSION,
        "prompt": LOCAL_VOICE_TEXT_PROMPT,
        "includeStartupContext": true,
        "clientManagedHandoffs": false,
        // Do not spend a second model response on "嗯/明白" while the
        // real Codex handoff is starting. It sounds like Jarvis is interrupting
        // the user and also consumes avoidable realtime output tokens.
        "delegationAckFiller": false,
        // STOP must be final. Flushing the tail can create a new Codex turn
        // after the user has already stopped the session.
        "flushTranscriptTailOnSessionEnd": false,
        "codexResponsesAsItems": false,
        "codexResponseHandoffMode": "commentary",
        "transport": {"type": "webrtc", "sdp": sdp}
    });
    let start_result = runtime.request("thread/realtime/start", params).await;
    if let Err(error) = start_result {
        *runtime.voice_phase.write().await = "error".to_owned();
        return Err(format!("Codex Voice V3 启动失败：{error}"));
    }
    Ok(direct_voice_info(&state).await)
}

#[tauri::command]
async fn stop_codex_voice(state: State<'_, AppState>) -> Result<DirectVoiceInfo, String> {
    let Ok(runtime) = runtime(&state).await else {
        return Ok(direct_voice_info(&state).await);
    };
    let thread_id = runtime.thread().await?;
    *runtime.voice_phase.write().await = "stopping".to_owned();
    let result = runtime
        .request("thread/realtime/stop", json!({"threadId": thread_id}))
        .await;
    runtime.voice_active.store(false, Ordering::SeqCst);
    *runtime.voice_phase.write().await = "closed".to_owned();
    *runtime.realtime_session_id.write().await = None;
    result?;
    Ok(direct_voice_info(&state).await)
}

#[tauri::command]
async fn append_codex_voice_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Voice 文本不能为空".to_owned());
    }
    let runtime = runtime(&state).await?;
    if !runtime.voice_active.load(Ordering::SeqCst) {
        return Err("Codex Voice 尚未连接".to_owned());
    }
    let thread_id = runtime.thread().await?;
    runtime
        .request(
            "thread/realtime/appendText",
            json!({"threadId": thread_id, "role": "user", "text": text}),
        )
        .await?;
    Ok(())
}

#[tauri::command]
async fn send_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let runtime = runtime(&state).await?;
    let thread_id = runtime.thread().await?;
    runtime
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{"type": "text", "text": text, "text_elements": []}]
            }),
        )
        .await?;
    Ok(())
}

#[tauri::command]
async fn stop_all(state: State<'_, AppState>) -> Result<(), String> {
    stop_local_voice_process(&state);
    let Ok(runtime) = runtime(&state).await else {
        return Ok(());
    };
    let thread_id = runtime.thread().await?;
    // A realtime handoff and STOP can cross in flight. Re-check briefly so a
    // turn that starts just after realtime/stop is interrupted as well.
    let mut interrupted_turn: Option<String> = None;
    for _ in 0..6 {
        if let Some(turn_id) = runtime.active_turn.read().await.clone() {
            if interrupted_turn.as_deref() != Some(turn_id.as_str()) {
                let _ = runtime
                    .request(
                        "turn/interrupt",
                        json!({"threadId": thread_id, "turnId": turn_id}),
                    )
                    .await;
                interrupted_turn = Some(turn_id);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    if let Ok(background) = runtime
        .request(
            "thread/backgroundTerminals/list",
            json!({"threadId": thread_id, "limit": 100}),
        )
        .await
    {
        if let Some(terminals) = background.get("data").and_then(Value::as_array) {
            for terminal in terminals {
                if let Some(process_id) = terminal.get("processId").and_then(Value::as_str) {
                    let _ = runtime
                        .request(
                            "thread/backgroundTerminals/terminate",
                            json!({"threadId": thread_id, "processId": process_id}),
                        )
                        .await;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn resolve_server_request(
    state: State<'_, AppState>,
    request_id: Value,
    approved: bool,
) -> Result<(), String> {
    let runtime = runtime(&state).await?;
    runtime.write(&json!({"id": request_id, "result": {"decision": if approved {"accept"} else {"decline"}}})).await
}

#[tauri::command]
async fn shutdown(state: State<'_, AppState>) -> Result<(), String> {
    stop_local_voice_process(&state);
    terminate_local_voice(&state).await;
    terminate_runtime(&state).await
}

#[tauri::command]
async fn quit_app(app: AppHandle) -> Result<(), String> {
    // A normal window close deliberately hides Wukong so the wake listener can
    // stay armed. Explicit Quit stops the microphone helper and Codex runtime,
    // then terminates the one protected application instance.
    let _ = stop_local_fallback_listener(app.clone()).await;
    let _ = disarm_wake_listener(app.clone()).await;
    let state = app.state::<AppState>();
    stop_local_voice_process(&state);
    terminate_local_voice(&state).await;
    let _ = terminate_runtime(&state).await;
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_agent_xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn ensure_background_launch_agent(app: &AppHandle) -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("无法读取 Wukong Codex 程序路径：{error}"))?;
    let executable_text = executable.to_string_lossy();
    // Never install a login item while running `tauri dev` from target/debug.
    if !executable_text.contains(".app/Contents/MacOS/") {
        return Ok(());
    }

    let home = std::env::var("HOME").map_err(|_| "无法读取用户目录".to_owned())?;
    let product_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "Wukong Codex".to_owned());
    let launch_agents = PathBuf::from(home).join("Library/LaunchAgents");
    fs::create_dir_all(&launch_agents)
        .map_err(|error| format!("无法创建登录启动项目录：{error}"))?;
    let launch_agent = launch_agents.join(format!("{product_name}.plist"));
    let temporary = launch_agents.join(format!(".{product_name}.plist.tmp"));
    let label = launch_agent_xml_escape(&product_name);
    let program = launch_agent_xml_escape(&executable_text);
    let contents = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{program}</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
"#
    );
    fs::write(&temporary, contents).map_err(|error| format!("无法写入后台常驻启动项：{error}"))?;
    fs::rename(&temporary, &launch_agent)
        .map_err(|error| format!("无法更新后台常驻启动项：{error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let arguments: Vec<String> = std::env::args().collect();
    let cold_wake_pending = arguments.iter().any(|argument| argument == "--jarvis-wake");
    let background_start = arguments.iter().any(|argument| argument == "--background");
    let application = tauri::Builder::default()
        // Register this first: login start, Dock launch and a cold wake can
        // otherwise create visually identical processes that must be quit one
        // at a time. A second launch now only raises the primary window.
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, _cwd| {
                let background = arguments.iter().any(|argument| argument == "--background");
                let wake_launch = arguments.iter().any(|argument| argument == "--jarvis-wake");
                if !background {
                    raise_jarvis_window(app);
                }
                if !background && !wake_launch {
                    let _ = app.emit("jarvis-manual-summon", true);
                }
            },
        ))
        .manage(AppState {
            runtime: Mutex::new(None),
            local_voice: Mutex::new(None),
            local_voice_playback_pid: AtomicU32::new(0),
            cold_wake_pending: AtomicBool::new(cold_wake_pending),
            background_start,
            wake_enabled: AtomicBool::new(false),
            wake_ready: AtomicBool::new(false),
            wake_supervisor_running: AtomicBool::new(false),
            wake_pid: AtomicU32::new(0),
            wake_authorization: RwLock::new("notDetermined".to_owned()),
            local_fallback_enabled: AtomicBool::new(false),
            local_fallback_running: AtomicBool::new(false),
            local_fallback_pid: AtomicU32::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            direct_voice_status,
            local_voice_status,
            prepare_local_voice,
            stream_local_voice,
            play_local_voice,
            stop_local_voice_playback,
            arm_wake_listener,
            disarm_wake_listener,
            wake_listener_status,
            start_local_fallback_listener,
            stop_local_fallback_listener,
            consume_cold_wake,
            default_workspace,
            startup_is_background,
            request_microphone_permission,
            start_jarvis,
            start_codex_voice,
            stop_codex_voice,
            append_codex_voice_text,
            send_text,
            stop_all,
            resolve_server_request,
            shutdown,
            quit_app
        ])
        .setup(move |app| {
            use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
            app.handle().plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--background"]),
            ))?;
            let _ = app.autolaunch().enable();
            #[cfg(target_os = "macos")]
            if let Err(error) = ensure_background_launch_agent(app.handle()) {
                eprintln!("background launch agent: {error}");
            }
            if let Some(window) = app.get_webview_window("main") {
                if background_start {
                    let _ = window.hide();
                } else {
                    raise_jarvis_window(app.handle());
                }
            }
            if background_start {
                start_wake_supervisor(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Wukong Codex");
    application.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            raise_jarvis_window(app);
            if !has_visible_windows {
                let _ = app.emit("jarvis-manual-summon", true);
            }
        }
    });
}
