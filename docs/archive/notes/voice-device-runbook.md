# Voice — device-day runbook (native ringing + VoIP push)

Everything except **native ringing on a physical device** is built and verified.
This is the checklist for the day Apple Developer enrollment completes — turning
on the one piece that needs a real device + an APNs key. Budget ~30–45 min.

The in-app call path (LiveKit media, ring banner, accept/leave) is already
live-verified mobile↔web. The server's APNs request construction is unit-verified
(`voip-apns.test.ts`) — so if a push doesn't ring, the problem is environment /
token / entitlement, **not** the request shape.

## 0. What "VoIP push" does here
On `call.ringing`, the server sends a **PushKit VoIP** push to the callee's
registered `kind='voip'` tokens. iOS wakes the (backgrounded/terminated) app,
`expo-callkit-telecom` parses the nested payload and rings via CallKit. We use
**token-based APNs auth** (a `.p8` key — one key works for both sandbox and
production), not a per-app certificate.

- Bundle id: `chat.atrium.app` · APNs topic: **`chat.atrium.app.voip`** · push-type `voip` · priority 10.
- Payload is the nested `incomingCall` shape (see `notes/voice-support.md` Phase 3).

## 1. Apple Developer portal — create the APNs Auth Key (.p8)
1. https://developer.apple.com/account → **Certificates, IDs & Profiles → Keys → +**.
2. Name it (e.g. "Atrium APNs"), enable **Apple Push Notifications service (APNs)**, Continue → Register.
3. **Download the `.p8` once** (you cannot re-download it). Note the **Key ID** (10 chars). Note your **Team ID** (top-right of the portal).
4. Confirm the App ID `chat.atrium.app` has **Push Notifications** capability enabled (Identifiers → chat.atrium.app).

> Treat the `.p8` like a password. Do NOT commit it or paste it anywhere public.

## 2. Server env (the only secrets)
Set on the server that handles signalling:
```
APNS_TEAM_ID=<team id>
APNS_KEY_ID=<key id>
APNS_AUTH_KEY_P8=<contents of the .p8, raw or base64>
APNS_BUNDLE_ID=chat.atrium.app
# Host must match the build's aps-environment (see note below). EAS internal/ad-hoc
# builds, TestFlight, and App Store are all PRODUCTION -> leave APNS_SANDBOX unset/0.
APNS_SANDBOX=0        # 0/unset -> api.push.apple.com (prod) ; 1 -> api.sandbox.push.apple.com (only a TRUE development-signed build)
```
Unset → the sender stays `noop` (foreground WS ringing still works). See
`surface/server/src/voip.ts` (`getVoipSender`) and `surface/server/src/config.ts`.

**Environment is the #1 gotcha (the runbook had this WRONG — corrected after a real device test 2026-06-16):** the host must match the build's `aps-environment` entitlement, which is set by the *provisioning profile*, not by the "development" label. An **EAS build with `distribution: internal`** (the `development` and `preview` profiles) is signed with an **ad-hoc** profile → `aps-environment: production` → a **production** push token → use the **production** host (`APNS_SANDBOX` unset/0). TestFlight and App Store are production too. Only a *true* development-signed build (e.g. local `expo run:ios` with a development profile) yields a **sandbox** token (`APNS_SANDBOX=1`). Wrong host → APNs returns `BadDeviceToken` and the device never rings. The `.p8` works for both environments — only the host differs.

**Second gotcha — a defective `.p8`:** if the key authenticates on sandbox but production returns **`403 BadEnvironmentKeyInToken`** for *any* token (even a dummy) and it won't clear after ~an hour, the key itself is bad — **regenerate it** (Apple Developer → Keys → new APNs key). This is not propagation; waiting won't fix it. (Hit on 2026-06-16: the first key was dead on production for 4h; a fresh key worked instantly and the device rang.)

## 3. Build a device dev-client (native modules don't run in Expo Go)
The config is already in `app.json` (validated via `expo prebuild`): `UIBackgroundModes: [audio, voip]`, `NSMicrophoneUsageDescription`, `aps-environment` entitlement, and the LiveKit / react-native-webrtc / expo-callkit-telecom plugins.

Option A — EAS (no Mac cabling needed):
```
cd surface/mobile
eas login            # if needed
eas build --profile development --platform ios   # uses the `development` profile in eas.json
```
Register the test device (`eas device:create`) before the build so its UDID is in the provisioning profile, then install the resulting build on the device (QR/link).

Option B — local cable build:
```
cd surface/mobile
npx expo run:ios --device     # pick the connected iPhone; Xcode must have a signing team set
```
Either way the app must be signed with a team whose App ID has Push + the VoIP entitlement.

## 4. Register + verify the VoIP token
1. Launch the dev-client on the device, log in. `app/_layout.tsx` calls `registerVoIPPush()`; on the first PushKit token the app calls `api.registerPush({ token, platform:'ios', kind:'voip' })`.
2. Verify server-side:
   ```sql
   select user_id, platform, kind, length(token) from push_tokens where kind='voip';
   ```
   You should see a row for the device user (a ~64-hex or base64 token).

## 5. End-to-end ring test
1. **Background or fully kill** the app on the device.
2. From web (or a second device), place a call to that user.
3. Expected: server fires the APNs VoIP push → device wakes → **CallKit full-screen ring** with caller + channel → accept → joins the LiveKit room (2-way audio) → decline/end maps to `declineCall`/`leaveCall`.
4. Foreground sanity: with the app open, the call also rings (WS `call.ringing` → in-app/CallKit) — this already works.

## 6. Troubleshooting
- **No ring, app killed:** almost always APNs environment (see §2). Check the server log for the APNs `:status` and `reason` (`BadDeviceToken` = wrong sandbox/prod host or wrong bundle — remember EAS internal builds are **production**; `BadEnvironmentKeyInToken` (403) = the `.p8` isn't provisioned for the production environment, i.e. a defective key → regenerate it; `TopicDisallowed` = topic must be `<bundle>.voip`; `ExpiredProviderToken` = JWT clock skew / wrong Key/Team ID).
- **Rings in foreground but not when killed:** the WS path works but the VoIP push isn't landing — env or token registration (§2/§4).
- **`Forbidden`/auth errors:** Key ID / Team ID / `.p8` mismatch, or the key was revoked.
- The request itself (JWT ES256, headers, path, payload) is covered by `surface/server/src/voip-apns.test.ts` — green means the construction is correct.

## Android (FCM) — when there's an Android device + SDK
Android uses FCM high-priority **data** messages (no Apple involved): set
`FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT_JSON`; the app registers an `kind='voip'`
FCM token and `expo-callkit-telecom` rings via Jetpack Core-Telecom. This Mac
currently lacks the Android SDK, so defer until an Android emulator/device + SDK
is set up. (No Apple enrollment needed for the Android path.)
