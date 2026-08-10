$ErrorActionPreference = "Stop"

$projectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$runtimeDir = Join-Path $projectDir "src-tauri\voice-runtime"

uv python install 3.12
$pythonPath = (uv python find 3.12).Trim()
$pythonRoot = Split-Path -Parent $pythonPath

if (Test-Path $runtimeDir) {
    Remove-Item -Recurse -Force $runtimeDir
}
New-Item -ItemType Directory -Force $runtimeDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $pythonRoot "*") $runtimeDir

$runtimePython = Join-Path $runtimeDir "python.exe"
$env:PIP_BREAK_SYSTEM_PACKAGES = "1"
& $runtimePython -m ensurepip --upgrade
if ($LASTEXITCODE -ne 0) { throw "ensurepip failed with exit code $LASTEXITCODE" }
& $runtimePython -m pip install --no-cache-dir --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed with exit code $LASTEXITCODE" }
& $runtimePython -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchaudio
if ($LASTEXITCODE -ne 0) { throw "PyTorch installation failed with exit code $LASTEXITCODE" }
& $runtimePython -m pip install --no-cache-dir "qwen-tts==0.1.1"
if ($LASTEXITCODE -ne 0) { throw "Qwen TTS installation failed with exit code $LASTEXITCODE" }
& $runtimePython -c "import qwen_tts, soundfile, torch; print('Windows voice runtime ready', torch.__version__)"
if ($LASTEXITCODE -ne 0) { throw "Windows voice runtime import check failed" }
