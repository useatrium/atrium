# Phase 4 — Dogfood Runbook & Scorecard

The human part of the plan. Everything below is ready to execute; the 2–4 week
clock starts when a team is actually using it.

## What's being tested (pre-registered — do not move after starting)

| Threshold | Measure |
|---|---|
| ≥30% of sessions get ≥1 non-spawner viewer (after week 1) | `session_views` vs `sessions` (see SQL) |
| ≥1 organic take-over or fork per team per week | `events` where type=session.seat_changed |
| Team still active in week 3 unprompted | sessions/day trend |
| Someone says "I checked the pane instead of asking" | ask in retro |

**Failure reads:** never-spectated → single-player orchestrator in disguise; don't
build the company. Spectate-once-then-stop → provenance is demo not habit; pivot
the surface toward inbox/review-queue.

## Deploy recipe (current: local kind; for a team, move to a small box)

1. Cluster + Centaur: see JOURNAL 2026-06-10 setup entry (kind + helm recipe).
   For a team box: k3s on a VPS/Mac-mini per centaur's mac-mini-setup.mdx, same
   helm values (`infra/values.local.yaml`), images via `just build` + import.
2. **Real LLM (required for real dogfood):** `ANTHROPIC_API_KEY=sk-ant-… ./infra/use-real-anthropic.sh`
   then `cd ~/Code/centaur && just smoke claude-code` to confirm. (The Phase 0–3
   gates all ran against the deterministic mock; one real-model confirmation run
   is still pending a key.)
3. Surface: postgres (docker compose in surface/), `pnpm migrate`,
   server with `CENTAUR_BASE_URL`, `CENTAUR_API_KEY` (Centaur admin key),
   `SESSION_SECRET`; web via `pnpm build` + static serve or `pnpm dev` for LAN.
4. Invite flow: prototype auth is handle-based — fine for a trusted team; do not
   expose publicly without adding real auth.

## Metrics queries (run weekly; events table is the source of truth)

```sql
-- sessions per day
SELECT date_trunc('day', created_at) d, count(*) FROM sessions GROUP BY 1 ORDER BY 1;

-- % sessions viewed by a non-spawner (requires session_views — Phase 4 patch)
SELECT round(100.0 * count(DISTINCT v.session_id) / NULLIF(count(DISTINCT s.id),0), 1) AS pct
FROM sessions s LEFT JOIN session_views v
  ON v.session_id = s.id AND v.user_id <> s.spawned_by;

-- take-overs / grants per week
SELECT date_trunc('week', created_at) w,
       payload->>'reason' reason, count(*)
FROM events WHERE type = 'session.seat_changed' GROUP BY 1,2 ORDER BY 1;

-- spectate engagement proxy: views per session distribution
SELECT viewer_count, count(*) FROM (
  SELECT session_id, count(DISTINCT user_id) viewer_count
  FROM session_views GROUP BY 1) t GROUP BY 1 ORDER BY 1;
```

## Remaining build item for Phase 4 (small)

`session_views` table + insert on stream-open (server stream route), so
"% viewed by non-spawner" and spectate duration are durable rather than
in-memory presence. ~30 lines + test. Scheduled after Phase 3 lands (same file
ownership).

## Known prototype limits going into dogfood

- Workspace credentials for agents (per-user credential re-binding = future
  iron-proxy work; documented in JOURNAL upstream-findings).
- Single-process WS hub; in-memory unread (restart loses unread state).
- Handle-based auth; no E2EE; deploy inside a trusted network.
- Mock LLM until a real key is provided (sessions complete instantly and
  deterministically — fine for UX rehearsal, useless for real work).
