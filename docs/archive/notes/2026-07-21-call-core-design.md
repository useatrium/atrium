# Shared "call core" design — consolidating web + mobile `useCall`

Date: 2026-07-21
Scope: design only, no code changes. Read-only analysis of
`surface/web/src/useCall.ts` (744 LOC) and `surface/mobile/src/lib/useCall.ts`
(902 LOC), their consumers, and the shared wire types.

---

## 0. Verdict up front

**Consolidate, but not into a single hooks-driven room engine.** The honest,
high-value seam is a **pure shared module** (`@atrium/surface-client/call-core`)
that owns the platform-independent brain — state types, participant/phase
bookkeeping, `sortLiveCalls`/`upsert`/`remove`, the CallKit-free user enrichment,
and above all the **`CallEvent` reducer** (`handleCallEvent`, ~100 near-identical
lines each side) expressed as a pure `(state, event) → state` transition. The two
`useCall` hooks stay as **thin platform drivers** that hold the LiveKit `Room`,
own their refs, and call the shared reducer.

I explicitly recommend **against** pushing the LiveKit `Room` lifecycle itself
into shared code behind a fat platform-adapter interface. Section 9 shows why: the
mobile side interleaves ~28 CallKit/audio-session calls at ~11 distinct lifecycle
points, and a hook-based core would have to invent, name, and correctly order all
11 hooks — adding indirection at exactly the seam whose regressions are most
expensive (verified-on-real-iPhone CallKit behavior) while deleting only ~120 LOC
of `Room` wiring that is *already* mostly parallel. The reducer + pure functions +
types are where the duplication actually is and where unification is provably safe.

The design below specifies BOTH the full adapter approach (so the tradeoff is
concrete and the CallKit interleavings are made fully explicit, per the brief) and
the recommended smaller consolidation, and states which parts of each are worth
shipping.

---

## 1. Side-by-side inventory

### 1.1 Imports

| | web (`surface/web/src/useCall.ts`) | mobile (`surface/mobile/src/lib/useCall.ts`) |
|---|---|---|
| React | `useCallback,useEffect,useRef,useState` (L1) | same (L1) |
| LiveKit | `Room,RoomEvent,Track,Participant,RemoteParticipant,RemoteTrack,RemoteTrackPublication` (L2-10) | `Room,RoomEvent,Track,Participant,RemoteParticipant` (L3) — **no RemoteTrack/Publication** |
| RN audio | — | `AudioSession` from `@livekit/react-native` (L2) |
| CallKit | — | 20 named imports from `expo-callkit-telecom` (L4-24) |
| shared | `CallEvent,CallJoin,CallWire,UserRef` (L11) | `+ApiError,CALL_RING_TTL_MS,channelLabel,Api,AppState,Channel` (L25-36) |
| local | `ApiError,api,Channel` from `./api`; `desktopApiOptions` from `./desktop` (L12-13) | `NATIVE_CALL_UI` from `./nativeCallUi` (L37) |

Key structural difference: **web imports the `api` singleton** (L12); **mobile
takes `api: Api` as a hook argument** (L149). The core must be the mobile shape
(api injected); the web wrapper injects its singleton.

### 1.2 `ActiveCallState` shape

| field | web (L20-28) | mobile (L39-47) |
|---|---|---|
| `call: CallWire` | ✓ | ✓ |
| `phase: 'connecting'|'connected'|'ended'` | ✓ | ✓ |
| `participants: UserRef[]` | ✓ | ✓ |
| `activeSpeakerIds: Set<string>` | ✓ | ✓ |
| `muted: boolean` | ✓ | ✓ |
| `error: string | null` | ✓ | ✓ |
| `remoteAudioTracks: RemoteAudioTrackRef[]` | ✓ (web-only) | — |
| `nativeCallId?: string` | — | ✓ (mobile-only) |

`RemoteAudioTrackRef` (web L15-18): `{ key: string; track: RemoteTrack }`.
Consumed only by `surface/web/src/components/CallUI.tsx` (the `RemoteAudio`
component, L15-32/L205-206) to `track.attach(<audio autoPlay>)`.

### 1.3 Module-level state fields (hook body)

| ref/state | web | mobile | note |
|---|---|---|---|
| `incomingCall` state | L180 | L159 | identical role |
| `activeCall` state | L183 | L160 | identical role |
| live-calls list state | `liveCalls` L181 | `recoverableCalls` L161 | **renamed + divergent semantics** |
| `dismissedCallIds` | React **state** L182 | **ref** L188 | **DIVERGENT storage** |
| `dismissedCallChannels` | — | ref `Map` L189 | mobile-only (per-channel snapshot reconciliation) |
| `notice` | L184 | L162 | identical |
| `starting` | L185 | L163 | identical |
| `answering` | L186 (plain) | L164 + `answeringRef` mirror L168 + `setAnswering` L169 | mobile mirrors to ref for CallKit listeners |
| `roomRef` | L187 | L174 | identical |
| `activeCallRef` | L188 | L175 | identical |
| `incomingCallRef` | — | L176 | mobile mirrors for listeners |
| `recoverableCallsRef` | — | L177 | mobile |
| `channelsRef` | L172 (`channelsRef`) | L178 | identical role |
| `connectPromiseRef` | L190 | L179 | identical |
| `detachRoomHandlersRef` | L191 | L180 | identical |
| `intentionalDisconnectRef` | L192 | L181 | identical |
| `mountedRef` | — | L165 | mobile-only guard |
| native-mapping refs (6) | — | L182-187 | **CallKit-only** (see 1.7) |

Mobile's 6 native-mapping refs (L182-187): `nativeIdByCallIdRef`,
`callIdByNativeIdRef`, `nativeEndRequestedRef`, `answeredNativeRequestsRef`,
`nativeIncomingReportPendingRef`, `nativeIncomingReportedRef`.

### 1.4 Pure helper functions

| helper | web | mobile | classification |
|---|---|---|---|
| `AUDIO_CAPTURE_OPTIONS` | L30-34 | L49-53 | **byte-identical** |
| `fallbackUser` | L41-43 | L56-58 | identical |
| `upsertUser` | L57-65 (**merge-aware**) | L60-62 (**add-only**) | DIVERGENT (web is a superset) |
| `removeUser` | L119-121 | L64-66 | **identical** |
| `participantsFor` | L92-95 (+enrich) | L68-70 (no enrich) | web superset |
| `sortLiveCalls` | L127-129 (**ASC** startedAt, then id) | L72-76 (**DESC** startedAt, filters ended) | **DIVERGENT sort order** |
| `upsertLiveCall` | L142-148 (+normalize) | L78-84 | same shape, web normalizes |
| `updateLiveCall` | L150-165 (+normalize) | L86-94 | same shape |
| `removeLiveCall` | — (inline `.filter`) | L96-98 | trivially unifiable |
| `isLiveCall` | L123-125 | inline `status!=='ended'` | trivial |
| `callUnavailable` | L167-169 | L108-110 | **identical** |
| `mergeUser`/`isFallbackUser` | L45-55 | — | web-only enrichment |
| `dedupeUsers`/`userFromIdentity`/`enrichParticipants`/`normalizeCall`/`normalizeLiveCalls`/`upsertIdentityParticipant(s)` | L67-117,131-140 | — | web-only enrichment |
| `userForCall` | in `callPresentation.ts` L9 (**duplicated**) | L112-118 | identical logic, two copies |
| `labelForCallChannel` | in `callPresentation.ts` L17 (**duplicated**) | L120-124 | identical logic, two copies |
| `ringAgeMs`/`isExpiredRing` | — | L100-106 | mobile-only (uses shared TTL) |
| `incomingCallEventFor` | — | L126-142 | **CallKit-only** |
| `serverCallIdFromSession` | — | L144-146 | CallKit-only |
| `RING_TIMEOUT_MS`/`CALL_REFRESH_INTERVAL_MS` | `RING_TIMEOUT_MS=45_000` L35 | `CALL_REFRESH_INTERVAL_MS=45_000` L54; ring TTL from shared `CALL_RING_TTL_MS=60_000` | **DIVERGENT ring timeout: 45s web vs 60s mobile** |

> Note the duplication is worse than 2 files: web's `userForCall`/`labelForCallChannel`
> live in a third file, `surface/web/src/callPresentation.ts` (L9, L17), imported by
> `Chat.tsx` (L35). Mobile keeps them in `useCall.ts` and exports `labelForCallChannel`.

### 1.5 Exported functions (hook return)

| export | web (L725-743) | mobile (L884-901) |
|---|---|---|
| `incomingCall` | ✓ | ✓ |
| `activeCall` | ✓ | ✓ |
| `notice` | ✓ | ✓ |
| `starting` | ✓ | ✓ |
| `answering` | ✓ | ✓ |
| `handleCallEvent` | ✓ | ✓ |
| `refreshActiveCalls` | ✓ (no args) | ✓ (`{channelId?}`) |
| `startCall` | ✓ | ✓ |
| `acceptIncomingCall` | ✓ | ✓ |
| `declineIncomingCall` | ✓ | ✓ |
| `toggleMute` | ✓ | ✓ |
| `leaveActiveCall` | ✓ | ✓ |
| `clearNotice` | ✓ | ✓ |
| `liveCalls` | ✓ | — |
| `liveCallForChannel` | ✓ | — |
| `joinCall` | ✓ | — |
| `declineCall(callId)` | ✓ | — |
| `recoverableCall` / `recoverableCalls` | — | ✓ |
| `joinRecoverableCall(callId?)` | — | ✓ |
| `acceptCallById` (internal, not returned) | — | ✓ (L512) |

### 1.6 Effects

| effect | web | mobile |
|---|---|---|
| re-enrich on `[channels,me]` | L197-208 | — (mobile does not re-enrich on channel change) |
| ring-timeout on active call | L707-721 (45s) | L773-787 (60s TTL) |
| incoming-ring TTL expiry | — | L793-807 (remaining-TTL) |
| `pagehide`/`sendBeacon` leave | **L676-705 (web-only)** | — |
| WS-down poll interval | — | **L811-817 (mobile-only)** |
| CallKit listener subscription | — | **L831-878 (mobile-only)** |
| `mountedRef` set/unset | — | L191-196 |
| unmount → `clearRoom` | L723 | L880 |

### 1.7 RoomEvent handlers (`setRoomHandlers`)

| RoomEvent | web (L256-319) | mobile (L268-327) |
|---|---|---|
| `ParticipantConnected` | upsert (enriched) L258-263 | upsert (simple) L270-278 |
| `ParticipantDisconnected` | remove + speaker + **drop remoteAudioTracks** L264-271 | remove + speaker L279-285 |
| `TrackSubscribed` | **✓ addRemoteAudioTrack L272-276 (web-only)** | — |
| `TrackUnsubscribed` | **✓ removeRemoteAudioTrack L277-281 (web-only)** | — |
| `ActiveSpeakersChanged` | upsert speakers + set L282-289 | set only L286-291 |
| `Disconnected` | leaveCall + notice L290-300 | **+ AudioSession.stop/restore + reportNativeEnded('failed')** L292-312 |

Web additionally, inside `connectToCall` (L358-369), walks existing
`remoteParticipants` and `addRemoteAudioTrack` for already-published audio; mobile
instead calls `publication.setSubscribed(true)` (L389) and relies on native
autosubscribe/AudioSession for playback (no track state kept).

### 1.8 The ~28 CallKit / native-audio call sites (mobile, exhaustive)

Every `expo-callkit-telecom` / `AudioSession` invocation, with the lifecycle
moment it fires at. This is the table the implementation must not silently drop.

| # | call | file:line | lifecycle moment |
|---|---|---|---|
| 1 | `AudioSession.stopAudioSession()` | L235 | `clearRoom` (intentional teardown) |
| 2 | `restoreAudioSession()` | L237 / L240 | after (1) settles |
| 3 | `reportCallEnded(nativeId, reason)` | L262 | `reportNativeEnded` |
| 4 | `AudioSession.stopAudioSession()` | L297 | `onDisconnected` (unexpected drop) |
| 5 | `restoreAudioSession()` | L299 / L302 | after (4) settles |
| 6 | `setNativeMuted(nativeCallId, muted)` | L335 | `applyNativeMute` (app→CallKit mirror) |
| 7 | `prepareAudioSessionForCall(false)` | L356 | `connectToCall`, before `new Room()` |
| 8 | `AudioSession.startAudioSession()` | L375 | `connectToCall` work, before `room.connect` |
| 9 | `fulfillIncomingCallConnected(incomingRequestId)` | L399 | connect success, incoming path |
| 10 | `reportOutgoingCallConnected(native.id)` | L401 | connect success, outgoing path |
| 11 | `failIncomingCallConnected(id, requestId)` | L409 | connect failure, incoming path |
| 12 | `reportCallEnded(id, 'failed')` | L411 | connect failure, outgoing/other |
| 13 | `getActiveCallSession()` | L439 | `reportIncomingToNative` pre-check (dedupe) |
| 14 | `reportIncomingCall(incomingCallEventFor(...))` | L445 | `reportIncomingToNative` |
| 15 | `getActiveCallSession()` | L447 | `reportIncomingToNative` post (capture session id) |
| 16 | `failIncomingCallConnected(id, requestId)` | L533 | `acceptCallById` catch |
| 17 | `startOutgoingCall({id:channelId,...})` | L657 | `startCall`, before connect (handle = channelId!) |
| 18 | `answerCall(nativeId)` | L688 | `acceptIncomingCall` (route accept via CallKit) |
| 19 | `endCall(nativeId)` | L706 | `declineIncomingCall` |
| 20 | `endCall(nativeCallId)` | L744 | `leaveActiveCall` |
| 21 | `addCallSessionAddedListener` | L833 | listener effect → `rememberNativeSession` |
| 22 | `addCallSessionUpdatedListener` | L834 | listener effect → `rememberNativeSession` |
| 23 | `addCallAnsweredListener` | L835 | listener effect → `acceptCallById` |
| 24 | `getActiveCallSession()` | L839 | answered-listener fallback (map recovery) |
| 25 | `failIncomingCallConnected(id, requestId)` | L844 | answered-listener, no serverCallId |
| 26 | `addCallEndedListener` | L850 | listener effect → clearRoom/leave/decline |
| 27 | `addSetMutedActionListener` | L865 | listener effect → `applyNativeMute` (CallKit→app) |
| 28 | `getActiveCallSession()` | L868 | listener-effect init (adopt in-flight session) |

Plus `startOutgoingCall`'s **channelId-as-handle** subtlety (L654-660 comment):
the CallKit handle is the *channelId*, not the per-call id, so native "recents"
group by conversation. Any refactor that plumbs `call.id` here is a silent
regression to call-back behavior.

---

## 2. Consumer inventory

### 2.1 Web

- **`surface/web/src/Chat.tsx`** — the sole hook host. `const calls = useCall(me, state.channels)` (L406). Wires `onCall: calls.handleCallEvent` into the WS frame handler (L1146), chains `calls.refreshActiveCalls()` after reconnect sync (L1110-1113). Reads `calls.starting`, `calls.activeCall`, `calls.incomingCall`, `calls.notice`, `calls.answering`, and **`calls.liveCallForChannel(active.id)`** (L2255) to render the per-channel "join live call" banner. Calls `calls.declineCall(activeChannelLiveCall.id)` (L2539). Also imports `labelForCallChannel`/`userForCall` from the **separate `callPresentation.ts`**, not from the hook.
- **`surface/web/src/components/CallUI.tsx`** — imports `ActiveCallState` type (L6) and `RemoteTrack` (L3). Owns the `RemoteAudio` `<audio autoPlay playsInline>` element that `track.attach()`es each `call.remoteAudioTracks[]` (L15-32, L205-206). This is the **web autoplay-policy seam** and the reason `remoteAudioTracks` exists in web state at all.

### 2.2 Mobile

- **`surface/mobile/src/lib/chat.tsx`** — hook host inside the chat context. `useCall({ api, me, channels, wsStatus })` (L304-309), passing `wsStatus: wsStatusKind(...) === 'open' ? 'open' : 'closed'` (L308). Exposes the whole `calls` object on context (`calls: ReturnType<typeof useCall>`, L112). Triggers `refreshActiveCalls()` once channels load (L862).
- **`surface/mobile/src/components/GlobalCallUI.tsx`** — renders banners from `calls.incomingCall / activeCall / recoverableCall / notice`, wires `acceptIncomingCall / declineIncomingCall / joinRecoverableCall(recoverableCall?.id) / toggleMute / leaveActiveCall` (L88-113). Imports `labelForCallChannel` from `../lib/useCall` (L7).
- **`surface/mobile/src/components/CallUI.tsx`** — renders `call.participants`, `call.activeSpeakerIds`, `call.muted` (L132-303). No native track element — playback is via AudioSession.
- **`surface/mobile/test/useCall.test.tsx`** — the existing safety net: mocks `@livekit/react-native`, `livekit-client`, `expo-callkit-telecom`, and `nativeCallUi` (`NATIVE_CALL_UI:false`), and asserts stale-ring drop / dismissed-persistence / ring-TTL / WS-down poll gating. Any core refactor must keep these green and should grow (Section 8).

### 2.3 Server interplay (`surface/shared/src/calls.ts`)

- Actions are HTTP (`startCall`/`acceptCall`/`declineCall`/`leaveCall`/`activeCalls`, `surface/shared/src/api.ts` L864-890). `activeCalls` takes `{channelId?}` — **mobile uses it, web calls it argless**.
- Lifecycle is WS: 6 `call.*` frames (`CallEvent`, L84-90), routed by `isCallEvent` (L93). Both hooks' `handleCallEvent` are the client half of this contract.
- TTL policy constants (`CALL_RING_TTL_MS=60_000`, L20) are shared. **Web's local `RING_TIMEOUT_MS=45_000` diverges from this and should be reconciled to the shared constant during consolidation** (behavior change, flag it — see risk R5).
- LiveKit media path never touches these hooks beyond `join.{token,url}`. The webhook reaper is server-side and out of scope; clients only observe its effects as `call.ended`/`participant_left` frames, which the shared reducer already handles.

---

## 3. Classification of every piece

**SHARED-IDENTICAL** (byte-same or trivially unifiable): `AUDIO_CAPTURE_OPTIONS`,
`fallbackUser`, `removeUser`, `callUnavailable`, `participantsFor` (mobile form),
`updateLiveCall`/`upsertLiveCall`/`removeLiveCall` shapes, `activeCallRef`/
`roomRef`/`connectPromiseRef`/`detachRoomHandlersRef`/`intentionalDisconnectRef`
patterns, the ring-timeout effect body, `clearNotice`, and the six-branch
`handleCallEvent` skeleton (ringing/accepted+joined/declined/left/ended).

**SHARED-WITH-PARAM** (same logic, platform value injected): `api` (singleton vs
injected — inject always), `channels` access (`channelsRef`), `sortLiveCalls`
(inject sort direction — see R4), live-list state (`liveCalls`/`recoverableCalls`
unify to one, expose both names via wrapper aliases), user enrichment (adopt web's
richer `mergeUser`/`userFromIdentity`/`enrichParticipants` as the core; mobile's
`userForCall`/`labelForCallChannel` become the same shared functions), ring
timeout constant (adopt shared `CALL_RING_TTL_MS`).

**PLATFORM-HOOK** (behavior only one platform has → lifecycle hook point):

- web-only: `RemoteAudioTrackRef` + `remoteAudioTracks` slice + `TrackSubscribed`/
  `TrackUnsubscribed` handlers + existing-track walk (the *audio-attachment* model);
  `pagehide`/`sendBeacon` tab-lifecycle leave; `desktopApiOptions` token plumbing.
- mobile-only: every row in the Section 1.8 table (28 sites) — CallKit report/
  answer/end/fail/fulfill/mute-mirror, `AudioSession` start/stop/restore/prepare,
  the CallKit listener effect, native-mapping bookkeeping, `reportIncomingToNative`,
  `incomingCallEventFor`; the WS-down poll interval; `mountedRef`.

**GENUINELY-DIVERGENT** (same event, different response — each needs a decision):

| # | divergence | web | mobile | decision |
|---|---|---|---|---|
| D1 | live-list sort order | ASC startedAt+id (L128) | DESC startedAt (L75) | **Pick one.** `recoverableCall` selection (mobile L882) and web's per-channel `.find` are both order-tolerant *today*, but if the core exposes an ordered `liveCalls`, the visible order changes on one platform. Recommend ASC (stable, web's) + document mobile banner picks "first non-incoming" regardless. |
| D2 | `dismissedCallIds` storage | React **state** (drives L197 re-enrich + `liveCallForChannel` memo dep L448) | **refs** + channel `Map` (L188-189) | Core keeps it as **state** (web needs reactivity); mobile's per-channel `Map` becomes an optional companion the mobile driver owns for its channel-scoped `refreshActiveCalls`. |
| D3 | `refreshActiveCalls` scoping | argless, replaces whole list (L393) | `{channelId?}` merge (L483) | Core takes optional `{channelId?}`; web wrapper never passes it. |
| D4 | ring timeout | 45s (L35) | 60s shared (L784) | Reconcile to shared 60s (web change — R5). |
| D5 | `onDisconnected` unexpected-drop | leave + notice (L290-300) | + audio restore + `reportNativeEnded('failed')` (L292-312) | The extra work is a PLATFORM-HOOK (`onUnexpectedDisconnect`), not divergent logic. |
| D6 | second incoming while active | `setNotice('Leave the current call…')` on join attempt (L327-330) | suppress incoming banner + guard native report (L465, L431) | Both refuse a second concurrent call; keep both behaviors (they are the same intent expressed at different layers). |
| D7 | `upsertUser` semantics | merge-aware (L57) | add-only (L60) | Adopt web's merge-aware (superset). Mobile gains fallback→real upgrades — an improvement, low risk. |
| D8 | accept routing | `joinCall`→`api.acceptCall` directly | `acceptIncomingCall`→`answerCall(nativeId)`→ CallKit `addCallAnsweredListener`→`acceptCallById` (indirect) | PLATFORM-HOOK: accept must be **interceptable** by the mobile adapter so CallKit drives the actual join. |

---

## 4. The seam — two designs

### 4.1 Where it lives

`shared/` (`@atrium/surface-client`) already depends on `react` (peer) and
`@atrium/centaur-client`, and already owns `calls.ts`. New module:
`surface/shared/src/call-core.ts`, exported as `@atrium/surface-client/call-core`.

**`livekit-client` dependency implication.** This is the load-bearing packaging
decision:

- The two apps pin **different** `livekit-client` majors/minors: web `^2.15.13`
  (`surface/web/package.json` L24), mobile `2.19.1` (`surface/mobile/package.json`
  L38, exact). A shared module that *imports* `livekit-client` would force a single
  version across both apps (or rely on peer-dep resolution), and would drag the
  full LiveKit client type/runtime surface into `shared`'s dependency graph —
  including for `shared` consumers that never touch calls (it is tree-shakeable at
  the bundler level only if the import lives in a leaf module the app doesn't pull).
- **Therefore the shared core must not import `livekit-client` at runtime.** It may
  import *types only* (`import type { Room } from 'livekit-client'`) if we accept a
  `devDependency`/`peerDependency` on it in `shared/package.json`; even that couples
  versions for typechecking. The clean answer for the **recommended (pure) design**
  is that the core touches **no LiveKit type at all** — the `Room` and its events
  stay entirely in each app's driver. `RemoteAudioTrackRef` (which embeds a
  `RemoteTrack`) is web-only state and stays in web.

This constraint is the strongest single argument for the pure-module design over
the fat-adapter design: the fat adapter would have to pass `Room`/`RemoteTrack`
across the seam and thus put `livekit-client` into `shared`.

### 4.2 Design A (recommended) — pure core + thin drivers

`call-core.ts` exports, all **LiveKit-free and CallKit-free**:

- Types: `CallPhase`, `BaseActiveCallState` (the 6 common fields; each app
  intersects it with its extra field), `LiveCallList` helpers.
- Pure functions: `fallbackUser`, `mergeUser`, `isFallbackUser`, `upsertUser`,
  `removeUser`, `dedupeUsers`, `userFromIdentity`, `enrichParticipants`,
  `participantsFor`, `normalizeCall`, `normalizeLiveCalls`, `sortLiveCalls(dir)`,
  `upsertLiveCall`, `updateLiveCall`, `removeLiveCall`, `isLiveCall`,
  `isExpiredRing`, `callUnavailable`, `userForCall`, `labelForCallChannel`.
- **`callEventReducer(state, event, ctx) → { active, incoming, live, effects }`** —
  a pure transition over the three state atoms, returning a small list of
  **intent effects** (`{kind:'reportIncoming',call}`, `{kind:'reportEnded',callId,
  reason}`, `{kind:'endedByLastLeave',callId}`, `{kind:'clearRoom'}`, …). The
  driver interprets effects; web ignores the CallKit ones, mobile acts on them.
  This is where the ~100-line-each `handleCallEvent` duplication actually dies.

Each app keeps its `useCall` hook (~250-350 LOC), but the hook now: holds refs +
`Room`, calls `callEventReducer` from `handleCallEvent`, and interprets the
returned effects. No LiveKit or CallKit type crosses into `shared`.

### 4.3 Design B (documented, not recommended) — `useCallCore(adapter)`

A shared hook owns the `Room` and calls a `CallPlatform` adapter at every
lifecycle point. This forces `livekit-client` into `shared` (4.1) and requires the
full hook table below. Presented so the CallKit interleavings are explicit and so
the reject decision is grounded, not hand-waved.

`interface CallPlatform` (every method, its trigger, and the CallKit site it
subsumes):

| adapter method | trigger point in Room lifecycle | web impl | mobile impl → CallKit site(s) |
|---|---|---|---|
| `beginOutgoing(call, channelName): Promise<NativeHandle?>` | in `startCall`, before `connectToCall` | `undefined` | `startOutgoingCall` **#17** (channelId handle) |
| `prepareForConnect(native)` | in `connectToCall`, before `new Room()` | no-op | `prepareAudioSessionForCall(false)` **#7** |
| `beginAudio()` | connect work, before `room.connect` | no-op | `AudioSession.startAudioSession()` **#8** |
| `onConnected(kind, native)` | after mic enabled, phase→connected | no-op | `fulfillIncomingCallConnected` **#9** / `reportOutgoingCallConnected` **#10** |
| `onConnectFailed(kind, native)` | connect catch | no-op | `failIncomingCallConnected` **#11** / `reportCallEnded('failed')` **#12** |
| `attachRemoteAudio(track,pub,part)` / `detachRemoteAudio(pub,part)` | `TrackSubscribed`/`TrackUnsubscribed` | update `remoteAudioTracks` | no-op (autosubscribe; `setSubscribed(true)` in connect loop) |
| `onUnexpectedDisconnect(callId)` | `RoomEvent.Disconnected`, not intentional | `notice` only | `AudioSession.stop`+`restoreAudioSession` **#4/#5** + `reportNativeEnded('failed')` **#3** |
| `onTeardown()` | `clearRoom` | no-op | `AudioSession.stop`+`restoreAudioSession` **#1/#2** |
| `applyMute(native, muted)` | `toggleMute` / CallKit mute action | `room.setMic` only | `room.setMic` + `setNativeMuted` **#6** |
| `reportEnded(callId, reason)` | reducer `reportEnded` effect / participant-left last leave | no-op | `reportCallEnded` **#3** (via mapping) |
| `reportIncoming(call, caller, channelName)` | reducer `reportIncoming` effect | no-op | `getActiveCallSession`+`reportIncomingCall`+`getActiveCallSession` **#13/#14/#15** |
| `interceptAccept(call): 'handled'|'proceed'` | `acceptIncomingCall` | `'proceed'` | `answerCall(nativeId)` **#18** → returns `'handled'`, CallKit re-enters via listener |
| `requestEnd(callId, native)` | `declineIncomingCall` / `leaveActiveCall` | no-op | `endCall` **#19/#20** |
| `subscribeNativeEvents({onAnswered,onEnded,onMuted,onSession})` | mount effect | no-op | `addCall*Listener` **#21-27**, `getActiveCallSession` init **#28** |

Even in Design B the **native-mapping bookkeeping** (the 6 refs, `rememberNativeSession`,
`clearNativeMapping`, `serverCallIdFromSession`, dedupe sets) stays entirely inside
the mobile adapter — it never generalizes. That is ~150 LOC of mobile-only state the
adapter can't delete, which is most of why B doesn't pay off (Section 8/9).

---

## 5. Lifecycle hand-computations

Notation: **W** = web today, **M** = mobile today, **A** = Design A (pure core),
**B** = Design B (adapter). "→" = ordered steps. CallKit sites cited by # from 1.8.

### (a) Outgoing: start → connected → peer joins → hangup

- **W**: `startCall`→`api.startCall`→`connectToCall`: `new Room`→`setRoomHandlers`
  →`setActiveCall(connecting)`→`room.connect`→`setMic(true)`→walk remote parts +
  `addRemoteAudioTrack`→phase=connected. Peer joins: `ParticipantConnected`→upsert;
  `TrackSubscribed`→add audio. Hangup: `leaveActiveCall`→`clearRoom`→`setActiveCall
  (null)`→`updateLiveCall(remove me)`→`api.leaveCall`.
- **M**: `startCall`→`api.startCall`→**#17 startOutgoingCall**→`connectToCall`:
  **#7 prepare**→`new Room`→handlers→`setActiveCall`→**#8 startAudioSession**→
  `room.connect`→`setMic(true)`→walk remotes `setSubscribed(true)`→phase=connected→
  **#10 reportOutgoingCallConnected**. Peer joins: `ParticipantConnected`→upsert.
  Hangup: `leaveActiveCall`→**#20 endCall**→`clearRoom`(**#1/#2 stop+restore**)→
  `setActiveCall(null)`→`updateLiveCall`→`api.leaveCall`.
- **A**: identical firing order to M on mobile / W on web — the driver still owns
  the `Room` and calls the effects at the same points; only the reducer/pure calls
  move. **No reordering.**
- **B**: order preserved *iff* `beginOutgoing`(#17) fires in `startCall` before
  `connectToCall`, `prepareForConnect`(#7) before `new Room`, `beginAudio`(#8)
  before `room.connect`, `onConnected`(#10) strictly after phase=connected. All
  expressible; no forced reorder.

### (b) Incoming: ring → answer → connected → remote hangup

- **W**: WS `call.ringing`→`handleCallEvent`→`setIncomingCall`. User taps accept→
  `acceptIncomingCall`→`joinCall`→`api.acceptCall`→`connectToCall`(as (a) inbound).
  Remote hangs up → `call.ended` or last `participant_left`→`clearRoom`+null.
- **M**: `call.ringing`→`handleCallEvent`→`setIncomingCall`+**#14 reportIncoming**
  (preceded by **#13**, followed by **#15**). Accept: `acceptIncomingCall`→
  **#18 answerCall(nativeId)** → CallKit fires `addCallAnsweredListener`(**#23**)→
  `acceptCallById`→`api.acceptCall`→`connectToCall`(**#7,#8**, then **#9
  fulfillIncomingCallConnected**). Remote hangup: `call.ended`→**#3 reportNativeEnded
  ('remoteEnded')**→`clearRoom`(**#1/#2**)+null.
- **A**: same order. The reducer emits `reportIncoming`/`reportEnded` effects at
  exactly the points M calls them; accept still routes through the mobile driver's
  `answerCall`→listener→`acceptCallById`. **No reorder.**
- **B**: **watch item** — `reportIncoming` must fire as a reducer effect *after*
  `setIncomingCall`, matching M (#14 currently runs inside `handleCallEvent` after
  `setIncomingCall`, L553-554). And `interceptAccept` must return `'handled'` so the
  core does *not* call `api.acceptCall` directly — the CallKit listener does, later.
  If B's core naively awaited accept inline, it would **reorder** (join before
  CallKit `answerCall` acknowledges), which is a regression. Flagged.

### (c) Incoming: ring → decline

- **W**: `declineIncomingCall`→`declineCall`→`setIncomingCall(null)`→
  `setDismissedCallIds.add`→`api.declineCall`.
- **M**: `declineIncomingCall`→`setIncomingCall(null)`→`removeLiveCall`→
  **#19 endCall(nativeId)**→`clearNativeMapping`→`api.declineCall` (on
  `calls_unconfigured`, fall back to dismissed refs L712-717).
- **A/B**: same order; decline is a `requestEnd` hook (#19) on mobile, no-op on web.
  No reorder.

### (d) Network drop mid-call → reconnect

- LiveKit auto-reconnect is internal to `Room`; neither hook subscribes to
  `Reconnecting`/`Reconnected` today — so from the hook's view a transient drop is
  invisible unless it terminates as `RoomEvent.Disconnected`.
- **On a terminal `Disconnected`** (unintentional): **W** → `onDisconnected`
  (L290) → `api.leaveCall` + `notice`. **M** → `onDisconnected` (L292) →
  **#4/#5 AudioSession.stop+restore** → `setActiveCall(null)` + notice →
  **#3 reportNativeEnded('failed')** → `api.leaveCall`.
- **A**: driver keeps its `onDisconnected`; effects unchanged. No reorder.
- **B**: `onUnexpectedDisconnect` must run stop/restore (#4/#5) **before**
  `reportEnded('failed')` (#3), matching M's L297-311 order. Expressible; call it
  out as an ordering contract in the adapter doc or it *will* be gotten wrong.
- Separately, mobile's **WS-down poll** (L811-817) is the real reconnect-recovery
  path: while `wsStatus!=='open'` and chrome is visible it polls `refreshActiveCalls`
  every 45s and reconciles. Web has **no** interval — it relies on `pagehide` +
  post-reconnect `refreshActiveCalls()` chained in `Chat.tsx` (L1110). Both stay as
  PLATFORM-HOOKs; no shared behavior to reorder.

### (e) Mute toggle — from app UI, and (mobile) from CallKit system UI

- **App UI, W**: `toggleMute`→`room.setMic(!next)`→`setActiveCall(muted=next)`;
  on failure re-sync to real mic state + notice.
- **App UI, M**: `toggleMute`→`applyNativeMute(nativeCallId,next)`:
  `room.setMic(!next)`→`setActiveCall(muted=next)`→**#6 setNativeMuted**.
- **CallKit UI, M only**: `addSetMutedActionListener`(**#27**)→`applyNativeMute`:
  `room.setMic`→`setActiveCall`→**#6 setNativeMuted** (mirrors back — idempotent).
- **A**: same. `applyMute` is a driver method; core doesn't touch the `Room`.
- **B**: `applyMute` hook does `room.setMic`+`setNativeMuted`(#6). The CallKit path
  enters via `subscribeNativeEvents.onMuted`→core `setMuted`→`applyMute`. Ordering
  identical. No reorder. (One subtlety: today `applyNativeMute` sets `room.setMic`
  *then* mirrors #6; a naive B that mirrored first would loop through the listener —
  keep set-mic-first.)

### (f) Second incoming call while one is active

- **W**: an active call is present; `call.ringing` handler (L456) requires
  `!activeCallRef.current` to set `incomingCall`, so the second ring is **not**
  surfaced as a banner. If the user somehow calls `joinCall` for it,
  `connectToCall` (L327) refuses with `notice('Leave the current call…')`. No
  second `Room`.
- **M**: `call.ringing` (L552) also requires `!activeCallRef.current` — banner
  suppressed. `reportIncomingToNative` (L431) additionally guards on
  `getActiveCallSession()`(**#13**) so it will **not** post a second CallKit
  incoming while one session is live. `connectToCall` refuses (L346). No second
  `Room`, no second CallKit call.
- **A/B**: reducer preserves the `!active` guard; mobile adapter keeps the
  `getActiveCallSession` guard inside `reportIncoming`. No reorder. **Neither
  platform truly "handles" call-waiting today; the core must preserve the refusal,
  not accidentally enable a second Room.**

**Reorder-risk summary:** Design A introduces **no** reordering on any of (a)-(f).
Design B introduces potential reordering in **(b)** (accept must be `'handled'`,
not inline-awaited) and **(d)** (stop/restore before reportEnded) — both are
adapter-contract ordering constraints that today are guaranteed by inline code and
would become invariants a future edit could break.

---

## 6. LOC estimate

Today: **744 (web) + 902 (mobile) = 1,646**, plus ~30 LOC duplicated in
`callPresentation.ts`.

**Design A (recommended):**

| unit | est. LOC |
|---|---|
| `call-core.ts` (types + pure fns + `callEventReducer` + effects) | ~430 |
| web `useCall.ts` driver (Room + refs + effect interpretation + pagehide + remoteAudioTracks) | ~300 |
| mobile `useCall.ts` driver (Room + refs + all CallKit + native mapping + listeners + poll) | ~430 |
| delete `callPresentation.ts` (folds into core) | −30 |
| **total** | **~1,160** |

Net: **~−490 LOC (~30%)**, concentrated in the reducer + pure-function dedupe.
The mobile driver barely shrinks (CallKit is irreducible); the win is web +
mobile *both* stop carrying their own copy of the reducer and enrichment.

**Design B (adapter):**

| unit | est. LOC |
|---|---|
| `useCallCore` shared hook (Room + reducer + adapter dispatch) | ~380 |
| `CallPlatform` interface + shared types | ~80 |
| web adapter | ~140 |
| mobile adapter (all CallKit + native mapping + listeners) | ~360 |
| web wrapper + mobile wrapper | ~60 |
| **total** | **~1,020** |

Net: **~−620 LOC**, but see Section 9 — the extra ~130 LOC saved buys a
`livekit-client` dependency in `shared`, two new ordering invariants ((b),(d)),
and indirection through 14 adapter methods at the most regression-sensitive seam.

---

## 7. Risk register (top 5)

| # | risk | why | catch |
|---|---|---|---|
| R1 | A CallKit interleaving silently dropped in the refactor (e.g. #10 `reportOutgoingCallConnected` or #6 mute mirror) → CallKit shows call stuck "connecting" or mute desyncs | 28 sites, several fire only on real device (`NATIVE_CALL_UI=Device.isDevice`) and are `.catch(()=>{})`-swallowed | Real-iPhone QA of every row in the 1.8 table; a CI checklist mapping each # to a code site; unit test asserting the mobile driver calls each mocked CallKit fn on the right transition (extend `useCall.test.tsx`). |
| R2 | Design B reorders accept (case (b)): core awaits `api.acceptCall` inline instead of letting CallKit `answerCall`→listener drive it → double-join or CallKit "answer" with no media | inline-await is the intuitive adapter shape; today's indirection is load-bearing | Unit test: `acceptIncomingCall` with `NATIVE_CALL_UI=true`+mapped nativeId calls `answerCall` and does **not** call `api.acceptCall` synchronously (only via the answered listener). Real-iPhone answer-from-lock-screen QA. |
| R3 | `livekit-client` pulled into `shared` (Design B) forces a single version; web `^2.15.13` vs mobile `2.19.1` drift causes type or runtime skew, and non-call `shared` consumers bloat | packaging coupling described in 4.1 | Design A avoids entirely (no LiveKit in core). If B: `pnpm --filter @atrium/web build:ci` + mobile typecheck + bundle-size check; verify tree-shaking of the call module. |
| R4 | Live-list sort flip (D1): unifying `sortLiveCalls` changes which recoverable/live call surfaces first on one platform | web ASC vs mobile DESC (L128 vs L75) | Unit test pinning order for both directions; mobile QA that `recoverableCall` still picks the intended call after multiple concurrent calls. |
| R5 | Ring-timeout reconciliation (D4): moving web from 45s→60s shared TTL changes "No answer" timing; or a missed reconcile leaves web at 45s while server sweeps at 60s | web hardcodes `RING_TIMEOUT_MS=45_000` (L35) vs shared `CALL_RING_TTL_MS=60_000` | Unit test on the ring-timeout effect using fake timers at the shared constant; web browser-QA of an unanswered outgoing call. |

Runner-up risks: web `remoteAudioTracks`/autoplay attachment lost if the web
driver stops walking existing `remoteParticipants` on connect (silent no-audio for
already-published tracks); `dismissedCallIds` reactivity (D2) — if core stores it
as refs, web's `liveCallForChannel` memo (L448) and re-enrich effect (L197) stop
updating.

---

## 8. Validation plan

**Unit tests (extend `surface/mobile/test/useCall.test.tsx` + add a shared
`call-core.test.ts`):**

- Pure `call-core`: property tests for `upsertUser` merge (fallback never
  overwrites real, D7), `enrichParticipants` dedupe, `sortLiveCalls` both
  directions (R4), `isExpiredRing` at the shared TTL boundary.
- `callEventReducer`: table-driven over all 6 `CallEvent` types × {active/incoming/
  neither present}, asserting the returned state atoms **and** the emitted effect
  list (e.g. `participant_left` last-leave emits `endedByLastLeave` — mobile L611-624).
- Mobile driver with mocked `expo-callkit-telecom` (`NATIVE_CALL_UI=true`): assert
  each CallKit fn from the 1.8 table is invoked on its transition, and **not**
  invoked when `NATIVE_CALL_UI=false`. Assert accept routes via `answerCall` not
  `api.acceptCall` (R2). Keep the four existing tests green (stale-ring, dismissed
  persistence, ring TTL, WS-down poll gating).
- Web driver: `toggleMute` failure re-syncs to real mic state; `onDisconnected`
  unintentional path calls `api.leaveCall` + sets notice; `remoteAudioTracks`
  add/remove on Track events.

**Web browser-QA (local LiveKit from `surface/docker compose up -d --wait`, then
`pnpm dev`; two browser profiles as two users, or the demo stream):**

- Outgoing call: start from channel header, second profile sees ring, accept,
  confirm two-way audio (the `<audio autoPlay>` attach path), mute toggles both
  ways, hang up from each side, "No answer" after the (now 60s) timeout.
- Reconnect: kill/restore the WS; confirm `refreshActiveCalls` reconciles and no
  phantom active call. `pagehide`: close the tab mid-call, confirm the beacon
  `leave` fires (server shows participant left).
- Per-channel live-call banner (`liveCallForChannel`) still renders and
  `declineCall` dismisses it.

**Cannot be validated without a real iPhone (residual risk Gary must accept):**
the entire CallKit surface only runs when `NATIVE_CALL_UI` (`Device.isDevice`) is
true — the simulator and unit mocks exercise our *call sites*, not iOS's CallKit
behavior. Specifically unverifiable off-device: answer-from-lock-screen and
answer-from-CallKit-UI (#18/#23), decline/end from the system call UI (#19/#20/#26),
system mute mirroring both directions (#6/#27), `AudioSession` route/restore
correctness (#1/#2/#4/#5/#8) so audio still plays after a call, VoIP-push→
`reportIncomingCall` interplay (#14), and outgoing-call "recents" grouping by
channelId handle (#17). Every one of these is `.catch(()=>{})`-swallowed, so a
regression is **silent** in logs. The verification matrix for a real-device pass is
exactly the 28-row table in Section 1.8.

---

## 9. Verdict and recommended cut

**Ship Design A (pure core + thin drivers). Do not ship Design B.**

Reasoning:

1. The duplication that actually hurts is the **reducer + enrichment + pure
   helpers + duplicated `callPresentation.ts`** — ~450 LOC of near-identical logic
   that A deletes with zero LiveKit/CallKit coupling and zero new ordering
   invariants. This is the ">34% identical" the verification found, plus the
   SHARED-WITH-PARAM tier.
2. Design B saves only ~130 LOC *more* than A, and buys three concrete liabilities:
   `livekit-client` in `shared` across two diverging versions (R3/4.1), and two new
   correctness invariants at the CallKit seam ((b) accept-routing, (d) stop-before-
   report) that inline code guarantees today and an adapter would leave to a future
   edit to break (R1/R2). The mobile native-mapping bookkeeping (~150 LOC, 6 refs,
   `rememberNativeSession`/`clearNativeMapping`/dedupe sets) does **not** generalize
   into the adapter regardless — so B's own core still can't touch the gnarliest
   mobile-only state. The indirection lands exactly where regressions are most
   expensive and least observable (real-iPhone, error-swallowed).
3. Put bluntly: the CallKit mirroring is entangled enough that a hook-based core
   adds indirection without deleting much of it. The room drivers should stay
   separate.

**Recommended concrete cut (Design A), in priority order:**

1. Create `surface/shared/src/call-core.ts` (`@atrium/surface-client/call-core`),
   LiveKit-free and CallKit-free: state types (`BaseActiveCallState`, `CallPhase`),
   all pure helpers, and `callEventReducer(state,event,ctx) → {state, effects}`.
   Adopt web's merge-aware enrichment and the shared `CALL_RING_TTL_MS`.
2. Delete `surface/web/src/callPresentation.ts`; re-export `userForCall`/
   `labelForCallChannel` from the core; repoint `Chat.tsx` (L35).
3. Rewrite both `useCall` hooks as thin drivers over the core: each keeps its
   `Room`, refs, and effects, and interprets the reducer's effect list (web ignores
   CallKit effects; mobile acts on them via its unchanged native code).
4. Reconcile the four documented divergences during the move: D1 sort (pick ASC),
   D2 dismissed-storage (state in core, mobile keeps its channel `Map` companion),
   D3 refresh scoping (optional `channelId`), D4/R5 ring timeout (shared 60s).
5. Land with the Section 8 unit tests **plus a real-iPhone pass over the full 1.8
   table** before it reaches the deploy branch — the mobile driver's public
   behavior must be byte-for-byte the same, and only a device proves it.

If even Design A feels too broad for one PR, the **minimum worth-it slice** is
steps 1-2 (types + pure helpers + `callEventReducer` + kill `callPresentation.ts`)
while leaving both `handleCallEvent` bodies calling the shared reducer but the rest
of each hook untouched. That captures the bulk of the real duplication with the
mobile `Room`/CallKit driver entirely unmoved — the lowest-risk high-value cut.
