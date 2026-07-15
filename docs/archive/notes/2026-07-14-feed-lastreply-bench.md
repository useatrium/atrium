# Channel-feed latest-reply benchmark

Run date: 2026-07-14. Environment: local compose PostgreSQL 16.14 on aarch64, database
`atrium_bench_ss15` on `localhost:5433`. Each reported latency distribution uses 50 measured
iterations after five warmups, independently for each of five channels. Pages contain 50
roots (the query fetches 51); the deep cursor is at about 80% of each channel's root history.

`--roots` is total roots across all channels. The deterministic mixed distribution produced
mostly quiet threads, some 1-20 reply threads, and one 200-reply thread per 200 roots. Five
percent of `message.posted` rows received an edit. The tables below show the median of the
five per-channel p50/p95 values; channel ranges are called out where useful.

## Results

| Scale / path | Page | p50 | p95 |
|---|---:|---:|---:|
| 5,000 roots / real `listChannelMessages` | first | 4.31 ms | 5.08 ms |
| 5,000 roots / real `listChannelMessages` | deep | 4.33 ms | 4.92 ms |
| 5,000 roots / full SQL | first | 4.29 ms | 5.09 ms |
| 5,000 roots / no-preview SQL | first | 3.84 ms | 6.26 ms |
| 5,000 roots / full SQL | deep | 4.37 ms | 5.10 ms |
| 5,000 roots / no-preview SQL | deep | 3.43 ms | 4.71 ms |
| 50,000 roots / real `listChannelMessages` | first | 501.83 ms | 672.79 ms |
| 50,000 roots / real `listChannelMessages` | deep | 465.14 ms | 523.53 ms |
| 50,000 roots / full SQL | first | 490.15 ms | 550.29 ms |
| 50,000 roots / no-preview SQL | first | 365.99 ms | 416.32 ms |
| 50,000 roots / full SQL | deep | 464.14 ms | 540.00 ms |
| 50,000 roots / no-preview SQL | deep | 352.92 ms | 444.82 ms |

Actual seeded scales were:

- 5,000 roots: 12,450 replies, 813 edits, 18,269 total events.
- 50,000 roots: 126,300 replies, 8,227 edits, 184,533 total events.

At the default scale, removing only the new preview select columns and the `lr`, `lru`, and
`lr_edit` joins saved a cross-channel-median 0.45 ms on the first page and 0.94 ms on the deep
page. Per-channel raw-SQL p50 overhead ranged from noise (-1%) to 28% on first pages and
18-33% on deep pages. The feature is measurable but small in absolute terms there.

At 10x roots, the preview block added 124.16 ms at the first-page median and 111.22 ms at the
deep-page median. That is 34% and 32% relative to the stripped baseline, respectively, but
only about 25% and 24% of total full-query time. Across individual channels it added 28-39%
over baseline on first pages and 29-42% on deep pages. It is material by 50,000 roots, but it
does not dominate the query even at that scale.

The whole query grows much faster than the fixed 51-row result size. `EXPLAIN (ANALYZE,
BUFFERS)` at 50,000 roots showed the full query around 443-633 ms and the stripped query
around 336-422 ms. Both variants spent substantial time in the other per-root modifier and
annotation folds; plans repeatedly enumerated `message.edited` rows through the partial GIN
index and sometimes a sequential scan. The extra last-reply edited-text lookup adds another
copy of that scaling pattern, which explains the preview delta. The `events lr` and `users
lru` joins themselves are primary-key lookups and are not the concern.

## Index experiment and verdict

The schema already provides the relevant access paths:

- `events_thread (thread_root_event_id, id) WHERE thread_root_event_id IS NOT NULL` for reply
  count/max;
- `events_target ((payload->>'target')) WHERE payload->>'target' IS NOT NULL` for root and
  last-reply edit lookup;
- primary keys for `events lr` and `users lru`.

The benchmark created this candidate after the unmodified measurements, analyzed the table,
reran the real path and SQL path, and dropped it before exit:

```sql
CREATE INDEX bench_feed_reply_types_idx
  ON events (thread_root_event_id, id)
  WHERE thread_root_event_id IS NOT NULL
    AND type IN (
      'message.posted',
      'session.replied',
      'session.question_requested',
      'session.question_answered',
      'session.question_resolved'
    );
```

At the default scale its median raw-SQL p50 improvement was only about 3% first-page and 11%
deep-page; real end-to-end medians were effectively flat (4.31 -> 4.37 ms first-page and
4.33 -> 3.78 ms deep-page). At 50,000 roots it caused a worse planner shape: candidate
end-to-end medians rose to 993.30 ms first-page and 1,117.86 ms deep-page, with EXPLAIN
surfacing large sequential scans/Gathers despite index-only reply scans. It therefore fails
the required >2x improvement threshold decisively and can regress the hot path.

**Verdict: do not add an index or migration for the latest-reply block.** The preview is not
the primary bottleneck at realistic/default scale. At larger scale it is worth optimizing,
but the productive target is the repeated edited/modifier/annotation folding strategy (for
example, reducing global per-row scans or materializing folds), not another
`thread_root_event_id` index. That broader query redesign is outside this lane.

## Reproduction

From `surface/`, after creating a database whose name contains `bench`:

```bash
DATABASE_URL=postgres://atrium:atrium@localhost:5433/atrium_bench_ss15 \
  pnpm --filter @atrium/server exec tsx scripts/bench-feed.mts --roots 5000

DATABASE_URL=postgres://atrium:atrium@localhost:5433/atrium_bench_ss15 \
  pnpm --filter @atrium/server exec tsx scripts/bench-feed.mts --roots 50000
```

The script wipes and reseeds the target database on every run. It refuses any database name
without `bench`.
