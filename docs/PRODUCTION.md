# Production release checklist

## Required before public distribution

- [ ] Enroll in the Apple Developer Program.
- [ ] Install a valid `Developer ID Application` certificate.
- [ ] Configure Apple notarization credentials in the release environment.
- [ ] Build on a clean macOS runner.
- [ ] Verify `com.apple.security.device.audio-input` exists in the final signature.
- [ ] Verify the nested wake helper signature.
- [ ] Notarize and staple the DMG.
- [ ] Test first-launch microphone and speech-recognition prompts.
- [ ] Test warm wake, cold wake, STOP, thread resume and text fallback.
- [ ] Publish SHA-256 checksums with the release.

## Local verification

```bash
npm ci
npm run check
npm run build
codesign --verify --deep --strict \
  "src-tauri/target/release/bundle/macos/Jarvis Codex.app"
codesign -d --entitlements :- \
  "src-tauri/target/release/bundle/macos/Jarvis Codex.app"
```

Expected entitlement:

```text
com.apple.security.device.audio-input = true
```

## Release boundary

An ad-hoc build is suitable only for local development. Do not describe it as a
production distribution: it is not notarized and macOS can treat later builds
as different identities for privacy permissions.
