# Harness Resume + Sleep Workstream

Tracking doc for the harness-state slice of the session resume/storage effort.
Strategy + rationale live in `agent-session-resume-and-storage-plan.md`; this is
the scoped checklist, status, and POC log. Created 2026-06-18.

## Goal

A Centaur session can sleep between turns and resume the *same* Codex/Claude
conversation after the sandbox is paused or rebuilt — instead of today's
behavior, where the sandbox is torn down ~60s after a terminal turn and the next
steer starts a fresh conversation.

## The two coupled requirements (Codex, validated)

Fresh-container Codex resume needs BOTH; neither alone is sufficient:

1. **Inject the thread id.** Set `CODEX_CONTINUE_THREAD_ID` = persisted
   `harness_thread_id` in the replacement sandbox's env. The harness-server
   already branches on this (`crates/harness-server/src/codex.rs:274` →
   `thread/resume` vs `thread/start`), but the Centaur workload spec never sets
   it and a regression test (`codex_workload_does_not_inject_stale_continue_thread_id`)
   asserts its absence.
2. **Restore the per-session harness home.** The rollout JSONL must be present at
   `$CODEX_HOME/sessions/.../rollout-<id>.jsonl` for `thread/resume` to find it.
   Today `sandbox.stateVolume.enabled: false` and nothing wires a volume to
   `CODEX_HOME`.

## POC log

### Codex resume (2026-06-18, codex-cli 0.140.0) — DONE

Method: throwaway `CODEX_HOME` (auth.json + config.toml copied), `codex exec` to
establish a codeword, then `codex exec resume <id>` under varying home contents.

- Same home → recalls. (baseline)
- Fresh home, **only `sessions/` JSONL copied, no sqlite** → recalls. ⇒ only the
  rollout JSONL is needed; `state_5.sqlite` et al. are not.
- Fresh home, **no `sessions/`** → `thread/resume failed: no rollout found for
  thread id <id> (code -32600)`. ⇒ resume is local-transcript-based, not
  server-side. This is the same app-server `thread/resume` path the harness-server
  uses, so it validates production, not just the CLI.

Conclusion: restoring one JSONL file per session is enough for Codex. Light.

### Claude resume (2026-06-18, Claude Code 2.1.181) — DONE (CLI behavior)

Method: real `~/.claude` (auth lives in macOS keychain `Claude Code-credentials`
+ a logged-in account marker in the config dir — a bare fresh `CLAUDE_CONFIG_DIR`
is "Not logged in"), isolated via a unique `/tmp` cwd so the session gets its own
project-key. `claude -p --session-id <uuid>` to establish, `claude -p --resume
<uuid>` to recall, moving files aside between turns.

- Same dir, everything present → recalls. (baseline)
- Transcript moved aside (sidecars remain) → `No conversation found with session
  ID`, non-zero exit. ⇒ local-transcript-based, NOT server-side.
- Transcript present, `session-env/<id>` sidecar removed → recalls. ⇒ the main
  project transcript JSONL is sufficient; the session-env sidecar is not needed
  for conversation continuity.

Conclusion: like Codex, only the main transcript JSONL is needed. TWO Claude
specifics that make its home heavier than Codex's:
1. **Path-keyed.** Transcript lives at `~/.claude/projects/<sanitized-cwd>/<id>.jsonl`
   — the project key is derived from cwd. Restoring the home is not enough; the
   cwd must match (or place the JSONL under the matching project-key dir). Codex
   indexes by thread-id (fs scan, cwd-agnostic on explicit-id resume).
2. **Auth/account state.** Restore must include the logged-in account marker, not
   just the JSONL (containers inject creds, so this is a restore-completeness note).

Still greenfield in Centaur: `crates/harness-server/src/claude.rs` has no resume
logic (Codex-only today) — the CLI supports `--resume`, but the harness path must
be implemented (analogous to codex.rs's thread/resume branch).

### Centaur/Atrium sleep + fresh-container resume — NOT RUN

See plan §"Centaur/Atrium POC": pass `idleTimeoutMs`, verify pause/resume of the
same sandbox, then force sandbox replacement with a preserved harness home and
confirm continuous conversation.

## Status checklist

- [ ] **Sleep (same-sandbox).** Pass `idleTimeoutMs` from `session-runs.ts`
      (client already supports it); stop the 60s release (`scheduleRelease` →
      `centaur.release`) or convert it to pause; surface `warm`/`sleeping` env
      state. DECISION OPEN: who owns the idle timer — Atrium (`idleTimeoutMs`) vs
      Centaur (`record_idle_pause`) — and how it reconciles with the release path.
- [ ] **Per-session harness home.** Wire `stateVolume` (currently generic mount,
      disabled by default) to a per-session PVC mounted at `CODEX_HOME` (and later
      `CLAUDE_CONFIG_DIR`); set the env vars in the workload spec. Per-session, not
      shared, to avoid concurrent-write corruption of the rollout JSONL.
- [ ] **Codex fresh-container resume wiring.** Inject `CODEX_CONTINUE_THREAD_ID`
      = `harness_thread_id` only on intentional resume (tie to session row +
      generation so the regression guard stays meaningful); update/replace the
      test that currently forbids it.
- [ ] **Claude harness resume.** Implement resume in `harness-server` claude path
      (greenfield). POC done: only the main transcript JSONL is needed, BUT it is
      path-keyed by cwd — restore must land it under the matching project-key dir
      (or pin the cwd), plus carry the logged-in account state.
- [ ] **Retention.** Per-session harness-home retention window; prune after the
      exact-resume window unless explicitly retained.

## Open questions (remaining)

- Claude project-key stability: the transcript path is derived from cwd, so the
  container checkout path must be stable/remapped across rebuilds (POC confirmed
  this matters; the min-file-set question itself is resolved — JSONL only).
- Does app-server `thread/resume` care about `cwd` matching (we passed the same
  cwd in the POC; explicit-id lookup ignored cwd filtering, but the agent operates
  in `cwd`)?
- Locking model so two containers never write the same rollout JSONL concurrently.
- Minimum safe retention for per-session harness homes.
- Is exact harness resume a user-visible guarantee or an optimization only while
  warm/sleeping?
