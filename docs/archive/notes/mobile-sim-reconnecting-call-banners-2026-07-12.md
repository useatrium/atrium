# Mobile iOS Simulator: stuck Reconnecting…, clipped banner, stale call UI

**Date:** 2026-07-12  
**Scope:** Research + live simulator exercise only (no code or DB changes).  
**Device:** iPhone 17 simulator, iOS 26.5 (`D2D677E3-BD1E-4DFE-941F-7864A4E8B840`)  
**App:** `chat.atrium.app` (Expo dev client)

## Summary

Three related symptoms on the Atrium iOS simulator:

1. **Stuck yellow “Reconnecting…”** banner under the channel header  
2. **Banner text clipped** (top of the label cut off)  
3. **Call chrome stuck at top:** “Bob is calling” + “Live call · general”

Live investigation showed they share one environment story (offline WS + cached UI) and two product bugs (orphaned server calls; banner layout under the stack header).

---

## What we saw (UI)

Stacked from top of screen:

| Layer | UI | Component |
|---|---|---|
| Top | Bob is calling · `hitl-ui-26985` · decline/accept | `IncomingCallBanner` via `GlobalCallUI` |
| Next | Live call · general · Join | `JoinCallStrip` (recoverable call ≠ incoming) |
| Channel header | `#hitl-ui-26985` · “1 here now” | Stack / channel screen |
| Thin yellow strip | Clipped **Reconnecting…** | `ConnectionBanner` |
| Overlay | Gray gear over accept | Expo Dev Menu (`gearshape.fill`) — not product UI |

Timeline content (HITL question cards, etc.) was still visible from **local SQLite cache**, not a live socket.

---

## Finding 1 — Call banners are server orphans (not pure client ghosts)

### Evidence

Server in use: **`http://127.0.0.1:3001`**  
(process cwd: `.worktrees/design-audit-plan/surface/server`)

`GET /api/calls/active` (as user `gary`, matching cached `actorId`) returned:

| Call id | Status | Channel | Started (UTC) | Approx age |
|---|---|---|---|---|
| `44d34957-cb76-46ba-b2dd-47b9aad9a682` | **ringing** | `hitl-ui-26985` (Bob initiator) | 2026-06-16 14:28 | ~26 days |
| `25cc2f5b-910b-47f8-83e1-e40336113ebe` | **active** | `general` (gary alone) | 2026-06-13 19:37 | ~29 days |

Postgres (`atrium-surface-db`, db `atrium`):

```text
25cc2f5b-… | active  | 2026-06-13 …
44d34957-… | ringing | 2026-06-16 …
```

Accessibility dump labeled the decline control with the live id:

```text
Decline call 44d34957-cb76-46ba-b2dd-47b9aad9a682
```

### Client behavior (by design)

`GlobalCallUI` can show **both** incoming and recoverable when they are different call ids:

```ts
// surface/mobile/src/lib/useCall.ts
const recoverableCall = activeCall
  ? null
  : recoverableCalls.find((call) => call.id !== incomingCall?.id) ?? null;
```

So the dual banners match two distinct non-ended rows, not a double-render of one call.

### Why they can’t be cleared

On this server, LiveKit is not configured:

```text
POST /api/calls/:id/leave    → 503 { error: "calls_unconfigured" }
POST /api/calls/:id/decline  → 503 { error: "calls_unconfigured" }
```

Meanwhile **`GET /api/calls/active` still lists** non-`ended` rows. So:

- Read path works → banners reappear on every successful `refreshActiveCalls`
- Mutate path fails → decline/leave cannot end the rows
- No server-side ring/active TTL observed for these orphans

### Client gaps that amplify this

| Gap | Detail |
|---|---|
| No client TTL for **incoming** ring | `RING_TIMEOUT_MS` (45s) only for **outgoing** active ring |
| Refresh mainly on WS open / initial load | While WS stuck, no catch-up; when WS briefly works, orphans rehydrate |
| Simulator has no CallKit | `NATIVE_CALL_UI = Device.isDevice` → false on sim; only in-app banners |

---

## Finding 2 — Clipped Reconnecting banner is a layout bug

### Code

```ts
// surface/mobile/src/components/bits.tsx — ConnectionBanner
paddingVertical: 3,
// font.xs = 11, no lineHeight
```

Shown whenever `wsStatus !== 'open'`:

```ts
// surface/shared/src/queueStatus.ts
export function reconnectingLabel(wsStatus) {
  return wsStatus === 'open' ? null : 'Reconnecting…';
}
```

### Live accessibility geometry

| Element | y | height | bottom |
|---|---|---|---|
| Channel nav (`RNSScreen`) | 182 | 54 | **236** |
| “Reconnecting…” text | **229** | 13.3 | 242 |

Almost the entire label sits **under the stack header**. That produces the yellow sliver / cut-off glyphs. Tight vertical padding makes it worse; the primary issue is **stacking under the header** when global call banners are present (`CallBannerLayout` zeros top safe area when a call banner shows).

---

## Finding 3 — Stuck Reconnecting: app was fully offline

### Live process state

While the full chat UI was on screen (with Reconnecting… + call banners):

- Atrium PID had **zero TCP sockets** (`lsof -a -p <pid> -iTCP` empty)
- No live REST, no live WS
- Timeline came from  
  `Documents/SQLite/atrium-event-cache.db`  
  (channel `11fee768-f448-4ba6-bd81-461afd7f5735`, cache write ~2026-07-12 morning)

### Host-side connectivity checks

| Target | Result |
|---|---|
| `ws://127.0.0.1:3001/ws?token=…` | **OPEN**, pong OK |
| `ws://localhost:3001/ws?token=…` | **OPEN**, pong OK |
| `http://127.0.0.1:3001` REST login/activeCalls | **OK** |
| `http://192.168.4.173:3001` | **ECONNREFUSED** |
| Server listen | **`127.0.0.1:3001` only** (not `0.0.0.0`) |

### Dev client / Metro

App preferences:

```text
expo.devlauncher.recentlyopenedapps → http://192.168.4.173:8081
```

After a controlled relaunch to re-check sockets, the sim fell into **Expo Dev Launcher**:

> No development servers found  
> Recently opened: Atrium · `http://192.168.4.173:8081`

Metro was not listening on 8081/8082 at investigation time. The earlier multi-hour Atrium process was a leftover JS session painting **cached** UI with a dead network.

### Likely reconnect story

```
Session/API URL uses unreachable host (e.g. LAN IP while server binds loopback)
  OR long-lived dev client with hung/dead socket layer
→ wsStatus stays connecting/closed
→ ConnectionBanner permanent
→ no call.ended / no refreshActiveCalls
→ call banners freeze (or reappear from orphans when REST briefly works)
→ UI still shows last SQLite timeline
```

Even when WS is healthy on localhost from the host machine, a **session `serverUrl` of `http://192.168.4.173:3001`** would never connect on this bind config.

---

## Finding 4 — Expo gear overlay

Accessibility node:

```text
AXLabel: gearshape.fill
frame: { x: 348, y: 96, width: 26, height: 26 }
```

Overlaps the accept control. This is the **Expo Dev Menu** floating control, not Atrium call chrome.

---

## Finding 5 — Decline did not clear UI while stuck

`idb ui describe-point` at the decline button center resolved to:

```text
Decline call 44d34957-cb76-46ba-b2dd-47b9aad9a682
```

Taps did not remove banners. Fits a half-dead JS runtime (no sockets) and/or server `503 calls_unconfigured` so any later successful refresh would resurrect orphans even if local optimistic clear ran.

---

## Root-cause map

```
DB has month-old ringing/active calls
  + LiveKit off → leave/decline 503
  → permanent call banners whenever client can read activeCalls

Server bound 127.0.0.1 only / session on unreachable LAN URL
  + long-lived dev client with dead sockets
  → permanent Reconnecting… over cached chat

Call banners + ConnectionBanner under stack header
  → clipped Reconnecting text
```

---

## Relevant code pointers

| Area | Path |
|---|---|
| Reconnecting label | `surface/shared/src/queueStatus.ts` |
| Mobile banner UI | `surface/mobile/src/components/bits.tsx` (`ConnectionBanner`) |
| Global call chrome | `surface/mobile/src/components/GlobalCallUI.tsx`, `CallUI.tsx` |
| Call state machine | `surface/mobile/src/lib/useCall.ts` |
| WS reconnect / wake | `surface/shared/src/useWs.ts`, `surface/mobile/src/lib/chat.tsx` |
| CallKit gated off on sim | `surface/mobile/src/lib/nativeCallUi.ts` |
| Calls unconfigured | `surface/server/src/routes/calls.ts` (`callsUnconfigured`) |
| LiveKit env | `surface/server/src/config.ts` (`LIVEKIT_*`) |

---

## Recommended fix directions (not implemented)

### Server (highest leverage for call banners)

1. **TTL / sweeper** for `ringing` and abandoned `active` calls (e.g. ring ~45–60s; active with 0 remotes after N minutes).  
2. Allow **decline/leave/end** (or a maintenance end) **even when LiveKit is unconfigured** so orphans can be closed.  
3. One-time cleanup of the two known rows (or all `status <> 'ended'` older than a threshold).

### Mobile

1. Incoming **ring client TTL** aligned with server.  
2. On decline/leave `calls_unconfigured` or extreme age: **drop local banner** and stop re-promoting from snapshot (or surface a clear “calls unavailable” notice).  
3. Periodic REST `activeCalls` while any call chrome is visible, even if WS is down.  
4. **ConnectionBanner layout:** ensure fully below header; set `lineHeight` / min height / padding so text never clips.

### Dev environment

1. Bind API on `0.0.0.0` for LAN device testing, **or** always log the simulator into `http://127.0.0.1:3001` / `localhost`.  
2. Keep Metro up for dev-client sessions (`192.168.4.173:8081` or localhost equivalent).  
3. Avoid multi-day sim processes as a reliability signal — relaunch after server rebinds.

---

## Exercise log (2026-07-12)

1. Confirmed booted sim + running Atrium; screenshot matched user report.  
2. Dumped accessibility tree via `idb` (frames for reconnect, calls, gear).  
3. Read app container cache (`atrium-event-cache.db`) → channel + gary actor id.  
4. Probed local servers; matched user/channel/call ids on **port 3001**.  
5. Confirmed orphan rows in Postgres; leave/decline → 503 unconfigured.  
6. Confirmed WS open on loopback; LAN IP refused; server listen = 127.0.0.1 only.  
7. Observed Atrium with **no TCP sockets** while UI still showed chat.  
8. Relaunch → Expo Dev Launcher, Metro missing at `192.168.4.173:8081`.

**Note:** Relaunch left the sim on the Dev Launcher screen. Start Metro / usual `expo run:ios` flow to re-enter the app.

---

## Open questions (for a fix PR if needed)

1. Is the mobile session `serverUrl` intentionally LAN (`192.168.x.x`) or localhost?  
2. Should unconfigured LiveKit still allow call lifecycle mutations that only touch DB state?  
3. Product rule for concurrent multi-call banners (incoming + join another channel) vs. single global call?

---

## Evidence artifacts

Local screenshots from the exercise (machine-local):

- `/tmp/atrium-sim-debug/screen1.png` — initial repro (calls + clipped reconnect)  
- `/tmp/atrium-sim-debug/screen3-after-decline2.png` — after decline taps (unchanged)  
- `/tmp/atrium-sim-debug/screen4-relaunch.png` — Dev Launcher, no Metro  
