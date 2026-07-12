# Native design-audit evidence (Maestro)

These flows drive the real Expo development build through visible text and React
Native accessibility labels. They use no screen coordinates. iOS and Android share
the same assertions except where native stack dismissal and Android system Back are
the behavior under test.

The suite proves an authenticated launch (rather than the email-code login UI),
first-run orientation in the bootstrapped empty `#general` workspace, all five
top-level destinations, search empty state, appearance preferences, a scripted agent
session, steering, result inspection, comments, and platform Back behavior. It does
not claim VoiceOver or TalkBack verification.

## Prerequisites

- Node 24+, pnpm 10+, Docker, Maestro, and a JRE.
- For iOS: Xcode with one supported simulator booted.
- For Android: an Android SDK, `adb` on `PATH`, and one emulator/device online.
- Run pnpm commands from `surface/`, the workspace root.
- Close the Expo development-client menu before starting Maestro. The flows do not
  dismiss it with a coordinate tap.

Install Maestro itself per its upstream instructions. A typical macOS shell has:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk
export PATH="$HOME/.maestro/bin:$JAVA_HOME/bin:$PATH"
maestro --version
```

## Deterministic reset and server

The first-run and collaboration flows expect Atrium's normal first-boot fixture:
workspace `atrium`, channel `#general`, auto-login user `qa`, no prior sessions, and
no message history. Reset it exactly as follows from `surface/` (this deletes only
the local Compose database and object-store volumes):

```sh
docker compose down -v
docker compose up -d --wait db minio livekit
pnpm --filter @atrium/server migrate
AUTH_OPEN=1 AUTH_DEV_CODES=1 ATRIUM_FULL_VIEW=1 PORT=3001 pnpm --filter @atrium/server start
```

Leave the server running. The server's idempotent bootstrap creates `#general`; the
mobile auto-login creates/uses the `qa` member. The collaboration flow starts the
built-in `demo` harness, so Codex, Claude, and Centaur credentials are not required.

## Build and install

In another shell from `surface/mobile/`:

```sh
EXPO_PUBLIC_AUTO_LOGIN="http://localhost:3001|qa|QA Tester" \
  npx expo run:ios --device "<booted simulator name>"

EXPO_PUBLIC_AUTO_LOGIN="http://10.0.2.2:3001|qa|QA Tester" \
  npx expo run:android --device
```

Use the host LAN address instead of `10.0.2.2` for a physical Android device. The
iOS simulator can use `localhost`; a physical iOS device also needs the host LAN
address. Expo SDK 56's native Stack supplies platform-default push/pop behavior;
`headerBackButtonDisplayMode="minimal"` only changes the iOS/web label presentation.

Worktree builds can retain path-bound Apple derived data. If iOS reports
`missing required module 'SwiftShims'`, perform a fresh `pnpm install` in this
worktree and remove `surface/mobile/node_modules/expo-modules-jsi/apple/.DerivedData`
plus `~/Library/Developer/Xcode/DerivedData/Atrium-*`, then build once more.

## Run order and commands

Reset once per platform. Run the files in numeric order because `02` creates the
demo session and `03` reuses `#general`.

```sh
# iOS
maestro test surface/mobile/.maestro/ios/01-first-run-and-navigation.yaml
maestro test surface/mobile/.maestro/ios/02-primary-collaboration-loop.yaml
maestro test surface/mobile/.maestro/ios/03-comment-on-message.yaml

# Android
maestro test surface/mobile/.maestro/android/01-first-run-and-navigation.yaml
maestro test surface/mobile/.maestro/android/02-primary-collaboration-loop.yaml
maestro test surface/mobile/.maestro/android/03-comment-on-message.yaml
```

Screenshots use unique `ios-*` and `android-*` names and land in Maestro's test
artifacts for the run. Preserve the run directory with the audit record; a checked-in
YAML file is not rendered evidence by itself.

## Coverage and unverified matrix

| Device/runtime | Authenticated launch | Navigation/settings | Demo/steer/result | Native Back | Runtime status in this checkout |
|---|---:|---:|---:|---:|---|
| iOS compact iPhone | authored | authored | authored | iOS stack Back | Unverified: no booted simulator; CoreSimulator service unavailable |
| iOS large iPhone | authored | authored | authored | iOS stack Back | Unverified: no booted simulator |
| iPad width | selectors reusable | selectors reusable | selectors reusable | iOS stack Back | Unverified; no device available |
| Android compact phone | authored | authored | authored | system Back key | Unverified: `adb` unavailable |
| Android expanded/tablet | selectors reusable; app uses a rail at 600dp | authored | authored | system Back key | Unverified; no runtime available |

Not deterministically seedable in the current local harness:

- The empty Attention state is captured, but exclusion of a simultaneously healthy
  running session is unverified. The demo completes in a few seconds and has no
  pause/gate with which to hold a stable running state during cross-tab navigation.
- Agent questions, approvals, authentication requests, failed/stalled sessions, and
  artifacts/file changes. The demo harness produces a successful transcript, tool
  result, and completion result only.
- Session cancellation/recovery. The demo is a short one-shot stream; racing its
  stop control would produce timing-dependent evidence rather than a stable test.
- Offline/reconnect. Maestro can toggle Android/iOS system connectivity only through
  device-specific permissions or external simulator commands, while stopping the
  shared local server would affect the test runner and is not an app-scoped fixture.
  A deterministic server fault/proxy control is needed before this becomes CI-safe.
- VoiceOver/TalkBack. Maestro traverses the accessibility tree but does not prove a
  screen-reader task was completed. Record those as separate manual sessions.

## Failure cleanup

On a failed flow, keep Maestro's logs and screenshots first. Then close the app,
reset preferences by rerunning `01` (it restores System theme, medium text, normal
contrast, and full motion), and use `docker compose down -v` before another clean evidence run. If a
demo session already exists, reset the database; `Run a demo agent` intentionally
appears only in the empty Agents state. Do not use `launchApp.clearState: true` with
the development client because it can return to the Expo launcher instead of Atrium.

## Selector maintenance

- Maestro matches the complete accessibility text. Use `.*substring.*` for dynamic
  rows such as messages and sessions.
- Prefer stable `accessibilityLabel` values and visible product language. Do not add
  coordinates to work around a missing semantic selector.
- Keep platform-neutral commands in `common/*.yml`; add platform-specific commands
  only for actual native behavior differences.
