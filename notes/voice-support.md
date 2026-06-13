# First-Class Voice for Atrium — Design & Plan

Status: **active build** (Phase 0 in progress)
Owner: voice workstream
Last updated: 2026-06-13

## Goal

First-class voice in Atrium:

1. **Voice calls** — 1-on-1 and group, highest practical quality/latency.
2. **Voice messages** — async audio messages with built-in speech-to-text transcription.

## Locked decisions

| Axis | Decision | Rationale |
|---|---|---|
| Transport | **Self-hosted LiveKit SFU** | One Apache-2.0 SDK for 1-on-1 + groups, web + Expo; no rewrite when groups land. No 3rd-party service dependency. |
| Media scope | **Voice-only** (foreseeable future) | Light bandwidth; LiveKit still future-proofs groups/video. |
| Encryption | **Hop-encrypted (DTLS-SRTP), E2EE-ready** | Keeps server-side transcription/recording easy; E2EE is a later flip via LiveKit insertable streams. |
| STT | **Self-hosted, pluggable adapter; CPU + async voice messages first** | No 3rd-party dependency; live captions deferred until a GPU exists. |
| Mobile | **Native ringing in v1** (CallKit / Android Core-Telecom + VoIP push) | First-class feel. The long pole — sequenced after the web stack is proven. |

Through-line constraint from the product owner: **no third-party SaaS dependencies for v1.** Everything self-hosted alongside the existing Docker + Caddy + Postgres + MinIO stack.

## First-principles split

These are two unrelated problems and must not share a transport:

- **Calls** = soft-real-time, loss-tolerant, latency-bound media (target <150 ms mouth-to-ear). Rides UDP/SRTP via WebRTC with a jitter buffer. The existing WebSocket sync hub carries **only signaling/state** (ring, accept, decline, end, in-call presence) — never audio frames.
- **Voice messages + STT** = async, store-and-forward, accuracy-bound. Reuses the existing S3 presigned upload flow + `events` table + push. Independent of the call stack; ships first.

## Responsibility split for calls (Phase 1+)

With LiveKit you **do not** hand-roll SDP/ICE over the WS hub:

- **WS hub (`hub.ts`)** owns the "phone" layer: `call.invite/ringing/accept/decline/cancel/leave/ended`, in-call presence, mute state.
- **LiveKit client SDK ↔ LiveKit SFU** owns the media layer: rooms, Opus tracks, jitter buffer, TURN fallback.
- **Fastify server** is the gatekeeper: mints LiveKit JWT access tokens **only after** `canAccessChannel(user, channel)` passes. The token is the capability; clients never choose a room freely. Room name = `call:<callId>`.

---

# Phase roadmap

- **Phase 0 — Voice messages + self-hosted STT** *(in progress; independent, lowest risk)*
- **Phase 1 — 1-on-1 calls on web** (LiveKit + embedded TURN, token minting, hub call protocol, web call UI)
- **Phase 2 — Group calls on web** (same stack, multi-party room, active-speaker UI)
- **Phase 3 — Mobile calling + native ringing** (custom Expo dev client, LiveKit RN SDK, CallKit/Core-Telecom, VoIP push) — the long pole
- **Phase 4 — Live captions / recording** (when a GPU is available; LiveKit Egress/Agents → streaming STT)

---

# Phase 0 — detailed spec

## Data flow

```
record (MediaRecorder web / expo-audio mobile, Opus)
  → POST /api/uploads  (existing presigned PUT)  → PUT bytes to S3/MinIO
  → POST /api/messages { ..., attachments:[fileId], voice:{durationMs, waveform} }
        server: insert message.posted (payload.voice + attachment)
                + insert transcripts row (status=pending)
                + enqueue in-process STT job
  → STT job (off event loop): adapter.transcribe(audio) → text
        server (main thread): update transcripts row (done)
                + insert voice.transcribed modifier event
                + hub.publishEvent  → clients patch the message's voice.transcript
```

## Why in-process (not a separate container)

The WS hub is **in-memory in the API process**. A separate worker process cannot call `hub.publishEvent`. For v1 the transcription job therefore runs **inside the API server process but off the event loop** (child-process whisper.cpp, or a worker thread), with a Postgres `transcripts` table providing durability + crash recovery + retries. Scaling to a dedicated worker later means adding Postgres `LISTEN/NOTIFY` (worker → API) for fan-out; out of scope for v1.

## Protocol contract (the foundation — frozen before fan-out)

**Shared types** (`shared/src/timeline.ts`):

```ts
export interface VoiceTranscript {
  status: 'pending' | 'done' | 'failed';
  text?: string;
  lang?: string;
}
export interface VoiceMeta {
  fileId: string;        // audio attachment id
  durationMs: number;
  waveform?: number[];   // 0..1 peaks for the scrubber (optional, ~40-64 buckets)
  transcript: VoiceTranscript;
}
// ChatMessage gains:  voice?: VoiceMeta
```

- A **voice message is a `message.posted`** whose `payload.voice` carries `{fileId, durationMs, waveform}` and whose `attachments` contains the audio file. `messageFromEvent` parses `payload.voice` into `voice`, defaulting `transcript.status='pending'`.
- **`voice.transcribed`** is a new **modifier** event (like `reaction.added`): `payload = { target_event_id, transcript: { status, text, lang } }`. `applyEvent` patches the target message's `voice.transcript`. Added to `isModifierEvent` + `mergeHistory` modifier handling so a reload re-applies it.
- `message.edited`/`message.deleted` continue to work unchanged on voice messages.

**API** (`shared/src/api.ts`): extend `postMessage` body with optional
`voice?: { durationMs: number; waveform?: number[] }`. No new endpoint.

**STT adapter** (`server/src/stt/adapter.ts`):

```ts
export interface SttResult { text: string; lang?: string; segments?: unknown[]; model: string }
export interface SttAdapter { name: string; transcribe(input: {
  s3Key: string; contentType: string; filename: string;
}): Promise<SttResult> }
// selected by env STT_PROVIDER; default 'noop' (returns '' — keeps CI green
// with no model download). Real impl: 'whispercpp' (child_process, model via
// WHISPER_MODEL_PATH) installed in the Docker image.
```

## Data model — migration `024_voice_transcripts.sql`

```sql
CREATE TABLE transcripts (
  file_id      uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  event_id     bigint REFERENCES events(id) ON DELETE CASCADE,  -- message.posted to patch
  workspace_id uuid NOT NULL,
  channel_id   uuid,
  status       text NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
  text         text,
  lang         text,
  segments     jsonb,
  model        text,
  error        text,
  attempts     int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- job-queue index: worker claims with FOR UPDATE SKIP LOCKED
CREATE INDEX transcripts_queue_idx ON transcripts (created_at)
  WHERE status IN ('pending', 'processing');
```

`event_id` is filled once the `message.posted` is inserted (same transaction as the message, or immediately after). Audio `duration_ms` lives in the message payload; the `files` row is unchanged (audio is just another attachment content-type).

## Client UX (Phase 0)

- **Composer**: a mic button → press-and-hold (or tap-to-start/tap-to-stop) recording with a live timer + waveform; release to preview (play / re-record / send / cancel). Capture waveform peaks during recording.
- **Timeline bubble**: audio player (play/pause, scrubber over the waveform, duration). Below it, the transcript: a subtle "Transcribing…" shimmer while `pending`, the text when `done`, nothing/retry affordance on `failed`.
- Reuse existing attachment fetch (`/api/files/:id` → presigned GET) for audio playback.

---

# Phase 1+ outline (not yet built)

**LiveKit**: run `livekit-server` in the Docker stack with its **embedded TURN on 443/TLS** (likely removes the need for a separate coturn). Server mints room tokens (JWT signed with `LIVEKIT_API_KEY/SECRET`) gated by channel access.

**Hub signaling additions**: `call.invite/ringing/accept/decline/cancel/leave/ended`, `call.participant_joined/left`, `call.token`. New `calls` + `call_participants` tables. Reuse `withIdempotency` on invite to avoid double-rings on retry. Extend hub presence with in-call state.

**Opus tuning**: mono, ~32 kbps, DTX on, RED/FEC on for loss resilience; WebRTC AEC/NS/AGC via `getUserMedia` constraints. RNNoise self-hosted later for SOTA noise suppression.

**Mobile (Phase 3)**: custom Expo dev client (not Expo Go) — `@livekit/react-native` + `@livekit/react-native-expo-plugin` + `@config-plugins/react-native-webrtc`; `expo-callkit-telecom` for CallKit/Core-Telecom; VoIP push (APNs PushKit / FCM high-priority data) to wake the app and ring natively, then join the room. iOS requires reporting the call to CallKit the instant PushKit wakes the app.

**Deployment risks**: Caddy is HTTP/TCP — it will **not** proxy LiveKit's UDP media. Expose LiveKit's ICE/UDP port range (and TURN on 443/TLS for restrictive networks) directly with firewalling. LiveKit is a stateful long-running process (fits the non-serverless model) but CPU/bandwidth-heavy — size the box; single-region latency for now.

**E2EE note**: LiveKit insertable-streams E2EE makes server-side recording/transcription of *call* audio impossible (server can't read it). So live captions and E2EE are mutually exclusive — decide per-feature when Phase 4 lands.

---

# Fan-out plan for Phase 0 (agent-fanout)

**Foundation (orchestrator, single commit, frozen before fan-out):**
shared types + reducer (`timeline.ts`), `api.ts` `postMessage.voice`, export wiring, migration `024`, `server/src/stt/adapter.ts` (interface + `noop`).

**Lane A — backend pipeline (codex):** `app.ts` messages route (accept `voice`, enqueue job, insert `transcripts` row), `events.ts` (store `payload.voice`, add `voice.transcribed` to allowlists + emit helper), `server/src/stt/worker.ts` + real `whispercpp.ts` adapter, boot wiring in `index.ts`, boot-time pending sweep, docker-compose + env docs. **CI must pass with `STT_PROVIDER=noop` (no model download).**

**Lane B — web UI (codex):** `web/src/*` — `VoiceRecorder` (MediaRecorder→Opus, waveform capture), composer integration, `VoiceMessage` playback bubble + transcript states. Canvas waveform (no new dep).

**Lane C — mobile UI (codex):** `mobile/*` — `expo-audio`/`expo-av` record + playback, voice bubble + transcript display, upload via shared api.

Disjoint ownership: foundation owns `timeline.ts`/`api.ts`/migration/`stt/adapter.ts`; A owns server `app.ts`/`events.ts`/`index.ts`/`stt/worker.ts`/compose; B owns `web/src`; C owns `mobile`. No file overlaps.
