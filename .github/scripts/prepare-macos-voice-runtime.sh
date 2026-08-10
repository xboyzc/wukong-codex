#!/bin/bash
set -euo pipefail

project_dir=$(cd "$(dirname "$0")/../.." && pwd)
runtime_dir="$project_dir/src-tauri/voice-runtime"

uv python install 3.12
python_path=$(uv python find 3.12)
python_root=$(cd "$(dirname "$python_path")/.." && pwd)

rm -rf "$runtime_dir"
mkdir -p "$runtime_dir"
rsync -a "$python_root/" "$runtime_dir/"
"$runtime_dir/bin/python3" -m ensurepip --upgrade
"$runtime_dir/bin/python3" -m pip install --no-cache-dir --upgrade pip
"$runtime_dir/bin/python3" -m pip install --no-cache-dir "mlx-audio==0.4.7"
"$runtime_dir/bin/python3" -c 'import mlx, mlx_audio; print("macOS voice runtime ready")'
