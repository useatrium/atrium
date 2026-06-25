-- Hard cut to direct Atrium CAS capture. Artifact bytes now commit only after
-- their cas_blobs row has an S3 key; the old Centaur staging/offload table is
-- no longer a production path.

DROP TABLE IF EXISTS session_artifacts;
