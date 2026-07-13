# v0.13.2 — draft release notes

## Highlights

- **Deskew, kept — with a fix.** v0.13's deskew step improved upright pages but
  over-cropped rotated ones. The crop is now clamped to the union of the detected
  content box and the original page box; the scanned-docs regression is gone.
- **Retry backoff survives cold starts.** The ingestion worker's retry ceiling is
  now 300s with full jitter, so an OCR pool cold start no longer strands batches
  in `pending_ocr`. Queue depth is logged on every retry.
- **Gallery view for run artifacts** — before/after screenshots below.

## Fixes

- preview service: transient 502s during thumbnail regeneration no longer bubble
  to clients (retried internally)
- `atlas evals fetch` verifies the corpus pin on both runs before diffing

## Upgrade notes

No schema changes. Config key `ingest.retry_ceiling_s` defaults to 300 (was 30).
