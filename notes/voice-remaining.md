# Voice — remaining work

Canonical "what's left" for first-class voice. Design: `notes/voice-support.md`.
Device/APNs setup: `notes/voice-device-runbook.md`. Last updated 2026-06-16.

## Shipped & verified
- **Voice messages + STT pipeline** (Phase 0, PR #6) — record → send → async `voice.transcribed` modifier event; durable `transcripts` job queue.
- **Web calls, 1-on-1 + group infra** (Phase 1, PR #8) — self-hosted LiveKit, REST + WS signalling. Live 2-tab QA passed.
- **Mobile in-app calls** (Phase 3, PR #9) — LiveKit RN client; live-verified on the iOS simulator.
- **Native CallKit ring + VoIP push wake on a real device** — the long pole. Verified end-to-end: cold-killed app rang via APNs (key `C5NS4JB9Y4`, production host).
- **Transcript retry + group-call participant names** (PR #13) — both browser-QA'd live (2026-06-16).

## Remaining

### Functional gaps
- [ ] **Real STT isn't running.** Default adapter is `noop` (empty text). The `whispercpp` adapter is built + unit-tested but needs the whisper.cpp binary + a model (`WHISPER_MODEL_PATH`, `STT_PROVIDER=whispercpp`, ffmpeg) baked into the deploy image. Until then voice messages transcribe to nothing. *(Biggest gap vs. the "voice messages with built-in STT" goal.)*
- [ ] **Group calls (3+) never live-tested.** Infra supports N participants; web panel polished (#13); only 2-party verified end-to-end.

### Built but unverified (no environment to test)
- [ ] **Android native ringing (FCM).** The FCM VoIP sender exists; never tested — this Mac has no Android SDK/device. Needs `FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT_JSON` + an emulator/device. (No Apple involved.)

### By-design future scope
- [ ] **E2EE.** Shipped hop encryption (DTLS-SRTP) and called it "E2EE-ready"; true end-to-end (LiveKit insertable-streams / FrameCryptor) not built. **Note:** E2EE and server-side live captions/recording are mutually exclusive (the server can't read encrypted call audio).
- [ ] **Live captions / recording** (Phase 4). Needs a GPU (LiveKit Egress/Agents → streaming STT).

### Deployment / ops
- [ ] **Production deploy of calls + VoIP push.** Everything to date is dev/LAN. Prod needs LiveKit prod config (host networking, embedded TURN, ports) + APNs prod env (`APNS_TEAM_ID=GS83M3FS29`, `APNS_KEY_ID=C5NS4JB9Y4`, `APNS_AUTH_KEY_P8`, `APNS_BUNDLE_ID=chat.atrium.app`, production host). Steps in `notes/voice-device-runbook.md`.
- [ ] (Hygiene) Revoke the old defective APNs key `AJ4R2XQJCG` in the Apple Developer portal — replaced by `C5NS4JB9Y4`; unused but still exists Apple-side.

### Polish / minor
- [ ] **Mobile late-joiner names show UUIDs.** Web was fixed in #13 (`useCall(me, channels)` resolves identities to real names); the mobile `useCall` still uses `userFromIdentity` (id-as-name) for `ParticipantConnected`.
- [ ] Minor review nits: server `prunePushTokens` wrapper; mobile incoming-banner per-screen render; `startOutgoingCall` uses `channelId` as the native handle.
- [ ] `expo-audio` pinned `56.0.11` (vs SDK's `56.0.12`) — min-release-age artifact.

## Recommended priority if shipping to production
1. **Real whisper STT in the deploy image** (otherwise transcription is empty).
2. **Production deploy** (LiveKit + APNs prod env, per the runbook).
3. Group-call (3+) live verification, if groups matter.

Everything else (E2EE, live captions, Android, polish nits) is optional / future.
