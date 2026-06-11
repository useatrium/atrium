-- Uploaded files (object bodies live in S3/MinIO; this is the metadata).

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  uploader_id UUID NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  -- Present for images so clients can reserve layout (no shift on load).
  width INT,
  height INT,
  s3_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_uploader_idx ON files (uploader_id, created_at DESC);
