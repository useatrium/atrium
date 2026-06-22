-- Normalize every CAS blob reference carried by artifact_versions so GC can
-- protect conflict-side blobs that are stored in jsonb rather than blob_sha.

CREATE TABLE IF NOT EXISTS artifact_blob_refs (
  artifact_id uuid NOT NULL,
  seq         int  NOT NULL,
  sha         text NOT NULL,
  role        text NOT NULL,
  PRIMARY KEY (artifact_id, seq, sha, role),
  FOREIGN KEY (artifact_id, seq) REFERENCES artifact_versions (artifact_id, seq)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS artifact_blob_refs_sha_idx
  ON artifact_blob_refs (sha);

CREATE OR REPLACE FUNCTION artifact_blob_refs_capture() RETURNS trigger AS $$
BEGIN
  INSERT INTO artifact_blob_refs (artifact_id, seq, sha, role)
  SELECT NEW.artifact_id, NEW.seq, NEW.blob_sha, 'version'
   WHERE NEW.blob_sha IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO artifact_blob_refs (artifact_id, seq, sha, role)
  SELECT NEW.artifact_id, NEW.seq, refs.sha, 'conflict'
    FROM (
      SELECT DISTINCT q.sha_node #>> '{}' AS sha
        FROM jsonb_path_query(COALESCE(NEW.conflict, '{}'::jsonb), 'strict $.**.sha') AS q(sha_node)
       WHERE jsonb_typeof(q.sha_node) = 'string'
    ) refs
   WHERE refs.sha <> ''
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifact_versions_capture_blob_refs ON artifact_versions;
CREATE TRIGGER artifact_versions_capture_blob_refs
  AFTER INSERT ON artifact_versions
  FOR EACH ROW EXECUTE FUNCTION artifact_blob_refs_capture();

INSERT INTO artifact_blob_refs (artifact_id, seq, sha, role)
SELECT artifact_id, seq, blob_sha, 'version'
  FROM artifact_versions
 WHERE blob_sha IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO artifact_blob_refs (artifact_id, seq, sha, role)
SELECT v.artifact_id, v.seq, refs.sha, 'conflict'
  FROM artifact_versions v
 CROSS JOIN LATERAL (
    SELECT DISTINCT q.sha_node #>> '{}' AS sha
      FROM jsonb_path_query(COALESCE(v.conflict, '{}'::jsonb), 'strict $.**.sha') AS q(sha_node)
     WHERE jsonb_typeof(q.sha_node) = 'string'
  ) refs
 WHERE refs.sha <> ''
ON CONFLICT DO NOTHING;
