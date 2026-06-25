# Mobile E2E validation (Maestro)

Flows here drive the **real app on a simulator** to validate touch interactions —
long-press, swipe, taps on accessibility-labelled controls.

## Why Maestro (and not idb / simctl)

`xcrun simctl` can't inject UI gestures. `idb ui tap --duration` *can* tap, but its
synthetic press does **not** register as a React-Native `onLongPress` — so long-press
menus (e.g. the message → **Comments** sheet) can't be reached with idb. Maestro
injects gestures through the accessibility layer, which RN recognises, and selects
elements by visible text / `accessibilityLabel` (no pixel coordinates). That makes it
the going-forward way to validate mobile interactions.

## One-time setup

```sh
brew install openjdk                       # Maestro needs a JRE (no sudo)
curl -Ls "https://get.maestro.mobile.dev" | bash
export JAVA_HOME=/opt/homebrew/opt/openjdk
export PATH="$HOME/.maestro/bin:$JAVA_HOME/bin:$PATH"
```

## Bring up the app, then run the flow

```sh
# 1. backend (dev defaults + open auth) — from surface/server
AUTH_OPEN=1 AUTH_DEV_CODES=1 ATRIUM_FULL_VIEW=1 PORT=3001 pnpm start

# 2. build + install the dev client on a booted sim, with auto-login — from surface/mobile
#    (a populated workspace gives the flow real channels/messages to act on)
EXPO_PUBLIC_AUTO_LOGIN="http://localhost:3001|qa|QA Tester" \
  npx expo run:ios --device "iPhone 17 Pro"

# 3. run the flows
maestro test surface/mobile/.maestro/          # all flows
maestro test surface/mobile/.maestro/comment-on-message.yaml
```

Screenshots (`takeScreenshot`) land in the working dir; `maestro test` exits non-zero
on any failed assertion, so this drops into CI later.

## Gotcha — building from a git worktree

`expo run:ios` from a **CoW-copied worktree** fails with
`missing required module 'SwiftShims'` (precompiled `.pcm` files baked with the
main-checkout path). Build from the main checkout, or if you must use a worktree, do a
fresh `pnpm install` (not a CoW copy) and clear
`expo-modules-jsi/apple/.DerivedData` + `~/Library/Developer/Xcode/DerivedData/Atrium-*`
first.

## Flows

- `comment-on-message.yaml` — post a message → **long-press** it → open **Comments** →
  add a comment. Validates the exact interaction idb couldn't (#105).

## Learnings (why the flow looks the way it does)

- **Anchored selectors.** Maestro matches an element's *whole* text. A chat row's
  accessibilityText is `"<author>, <time>: <body>"`, so target a message with
  `.*<body>.*`, not the bare body. Same for the comment composer (`Comment text Add a
  comment`).
- **Long-press needs a retry.** A synthetic long-press occasionally doesn't cross RN's
  `onLongPress` threshold (this is also why `idb` couldn't do it at all). Wrapping
  `longPressOn` + a wait-for-the-sheet in `retry` makes it reliable.
- **Accessibility was the real blocker.** The action sheet and the comments sheet
  exposed *nothing* to the accessibility tree (only their scrim) because a labelled
  `role="button"` modal backdrop collapses into one node and hides its children — from
  VoiceOver *and* from test drivers. Fixed in `MessageActions.tsx` / `EntryComments.tsx`
  by making the scrim + inner wrappers `accessible={false}`. **If you add a new modal,
  keep its backdrop non-accessible or its content won't be reachable.**
- **Dev-build noise.** The Expo dev-client menu pops on launch (dismiss via the backdrop
  tap, retried) and `clearState: true` drops you on the dev *launcher* — don't use it.
  During hot iteration, Fast Refresh can leave a stale `onLongPress`; a full app reload
  fixes it (a fresh `launchApp` run is unaffected).
