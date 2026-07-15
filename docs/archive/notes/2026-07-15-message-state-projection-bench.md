# message_state projection — feed read benchmark (2026-07-15)

Follow-up to `2026-07-14-feed-lastreply-bench.md`, which measured the read-time
fold stack (the old `MESSAGE_SELECT` LATERAL archaeology) at ~500ms p50 per
feed page at 50k roots and concluded the pre-existing per-row edit/annotation
folds — not the lastReply preview — were the real scaling problem.

This change replaces the read-time fold with the `message_state` write-time
projection (migration 080): every modifier write refolds its target (and the
target's thread root) transactionally via `refold_message_state(bigint)`, and
readers join the folded row by primary key.

## Method

`server/scripts/bench-feed.mts`, updated to compare the projection-backed
`MESSAGE_SELECT` against a frozen verbatim copy of the legacy fold SQL
(`LEGACY_MESSAGE_SELECT` in the script). Same seed shape as the 07-14 run:

```
DATABASE_URL=postgres://atrium:atrium@localhost:5433/atrium_bench_msp15a \
  pnpm --filter @atrium/server exec tsx scripts/bench-feed.mts \
  --channels 5 --roots 50000 --replies-per-root 0..20 --edits 5% --iterations 50
```

Seeded scale: `5ch / 50,000 roots / 126,300 replies / 8,227 edits / 184,533 events`.

## Results (p50 across 5 channels, 50 iterations each)

| variant | first page | deep page |
|---|---|---|
| legacy read-time fold | **~440–462ms** | **~440–447ms** |
| projection (raw SQL) | **7.1–8.2ms** | **2.5–3.3ms** |
| projection (through `listChannelMessages`) | 7.6–7.9ms | 2.7–3.3ms |

~60× on the first page, ~150× on deep pages. The legacy plans spend ~400ms in
per-row fold probes and bitmap scans over modifier events; the projection plans
are a handful of index scans (`events_channel_all`, `message_state_pkey`,
`events_pkey`) — read cost is no longer a function of modifier history length.

## Notes

- Backfill/rebuild must use the single-refold-per-row form
  (`SELECT refold_message_state(id) … WHERE type IN (row-owning types)`), not
  `project_message_event` per event: the classifier's root cascade is correct
  for live writes but quadratic on busy threads in bulk (measured: the 184k
  backfill crawled at ~3k events/min cascading, vs minutes total refolding).
- Bulk refolds are chunked (5k/statement) because each refold holds a
  `pg_advisory_xact_lock` until its transaction ends; one statement over the
  whole table exhausts the shared lock table.
- Correctness spine: `server/src/message-state.oracle.test.ts` asserts
  projection == frozen legacy fold over randomized writer sequences.
