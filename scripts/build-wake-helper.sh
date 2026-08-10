#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
helper_dir="$project_dir/src-tauri/wake-helper"
app_dir="$helper_dir/JarvisWakeListener.app"
binary_dir="$app_dir/Contents/MacOS"
signing_identity=${APPLE_SIGNING_IDENTITY:--}

if [[ -x "$binary_dir/JarvisWakeListener" \
  && "$binary_dir/JarvisWakeListener" -nt "$helper_dir/JarvisWakeListener.swift" \
  && "$app_dir/Contents/Info.plist" -nt "$helper_dir/Info.plist" \
  && "$binary_dir/JarvisWakeListener" -nt "$helper_dir/Entitlements.plist" ]] \
  && /usr/bin/codesign --verify --deep --strict "$app_dir" 2>/dev/null; then
  echo "Wake listener sources unchanged; preserving its existing macOS permission identity."
  exit 0
fi

mkdir -p "$binary_dir"
cp "$helper_dir/Info.plist" "$app_dir/Contents/Info.plist"
/usr/bin/swiftc \
  -O \
  -framework AppKit \
  -framework AVFoundation \
  -framework Speech \
  "$helper_dir/JarvisWakeListener.swift" \
  -o "$binary_dir/JarvisWakeListener"
/usr/bin/codesign \
  --force \
  --options runtime \
  --entitlements "$helper_dir/Entitlements.plist" \
  --sign "$signing_identity" \
  "$app_dir"
