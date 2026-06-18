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

### Claude resume — NOT RUN

Greenfield: `crates/harness-server/src/claude.rs` has no resume logic (Codex-only
today). Need to verify `claude --resume <id>` minimum file set (main transcript
vs. also tasks/file-history/subagent sidecars) and project-key stability when the
container checkout path changes. See plan §"Claude POC".

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
      + run the Claude POC for the minimum file set.
- [ ] **Retention.** Per-session harness-home retention window; prune after the
      exact-resume window unless explicitly retained.

## Open questions (remaining)

- Claude `--resume` minimum file set + project-key stability across checkout paths.
- Does app-server `thread/resume` care about `cwd` matching (we passed the same
  cwd in the POC; explicit-id lookup ignored cwd filtering, but the agent operates
  in `cwd`)?
- Locking model so two containers never write the same rollout JSONL concurrently.
- Minimum safe retention for per-session harness homes.
- Is exact harness resume a user-visible guarantee or an optimization only while
  warm/sleeping?
