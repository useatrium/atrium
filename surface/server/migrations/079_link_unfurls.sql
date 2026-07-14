CREATE TABLE link_unfurls (
  url_hash text PRIMARY KEY,
  url text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'error')),
  result jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ok' AND result IS NOT NULL) OR (status = 'error' AND result IS NULL))
);
