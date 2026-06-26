# Self-Improve Intervention Log

Append-only record of shipped interventions and failed attempts.

Before proposing a fix, check this log to avoid re-attempting fixes that already failed or are already in progress.

## PR Handoff Convention

Use PR labels as the required cross-system handoff.

Required labels:

- `self-improve`
- `fix-type:<type>`

Rules:

- Keep the PR body concise and reviewer-facing.
- Do not add hidden HTML-comment metadata blocks by default.
- Source-thread notifications are best-effort only. If future automation has privacy-safe source-thread metadata from another channel, it may pass it to the notifier input directly, but PR bodies should not carry private thread IDs.
- Keep the PR narrowly focused on the selected fix.

## Intervention Log

Each entry records one attempted fix and its outcome.

Format:

```
### YYYY-MM-DD: <fix title>
- fix_type: <type>
- pr: <pr_url or "not opened">
- outcome: <merged | closed | pending | abandoned>
- failure_mode_addressed: <the failure mode from gap analysis>
- impact_notes: <what changed after merge, if anything>
```

---

(No entries yet. The nightly loop will append entries here as fixes are shipped.)
