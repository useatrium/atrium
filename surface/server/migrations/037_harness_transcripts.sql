-- Harness-resume (rollout-JSONL project): the durable per-session harness
-- transcript captured by the node-sync daemon and restored into a fresh sandbox
-- on cold-start resume. This is INTERNAL harness state (the CLI's own session
-- transcript), NOT a user-facing work product, so it lives here, decoupled from
-- the artifact ledger / Files surface. Last-write-wins: each capture is a full
-- snapshot of the transcript, keyed by (session, harness). Bytes live in S3.

CREATE TABLE IF NOT EXISTS harness_transcripts (
  session_id uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  harness    text        NOT NULL,
  s3_key     text        NOT NULL,
  size_bytes bigint      NOT NULL,
  sha256     text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, harness)
);
