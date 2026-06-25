ALTER TABLE cas_blobs
  ADD COLUMN IF NOT EXISTS detected_mime text,
  ADD COLUMN IF NOT EXISTS media_kind text,
  ADD COLUMN IF NOT EXISTS is_text boolean,
  ADD COLUMN IF NOT EXISTS text_encoding text,
  ADD COLUMN IF NOT EXISTS classification_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE cas_blobs
   SET detected_mime = COALESCE(detected_mime, mime),
       media_kind = COALESCE(
         media_kind,
         CASE
           WHEN mime LIKE 'text/%' THEN 'text'
           WHEN mime = 'application/json' OR mime LIKE '%+json' THEN 'json'
           WHEN mime LIKE 'image/%' THEN 'image'
           WHEN mime LIKE 'audio/%' THEN 'audio'
           WHEN mime LIKE 'video/%' THEN 'video'
           WHEN mime = 'application/pdf' THEN 'pdf'
           WHEN mime IN ('application/zip', 'application/x-tar', 'application/gzip') THEN 'archive'
           ELSE 'binary'
         END
       ),
       is_text = COALESCE(
         is_text,
         mime LIKE 'text/%'
           OR mime = 'application/json'
           OR mime LIKE '%+json'
           OR mime = 'application/xml'
           OR mime LIKE '%+xml'
           OR mime IN ('application/javascript', 'application/x-javascript')
       ),
       text_encoding = CASE
         WHEN text_encoding IS NOT NULL THEN text_encoding
         WHEN mime LIKE 'text/%'
           OR mime = 'application/json'
           OR mime LIKE '%+json'
           OR mime = 'application/xml'
           OR mime LIKE '%+xml'
           OR mime IN ('application/javascript', 'application/x-javascript')
           THEN 'utf-8'
         ELSE NULL
       END;

ALTER TABLE cas_blobs
  ALTER COLUMN detected_mime SET NOT NULL,
  ALTER COLUMN detected_mime SET DEFAULT 'application/octet-stream',
  ALTER COLUMN media_kind SET NOT NULL,
  ALTER COLUMN media_kind SET DEFAULT 'binary',
  ALTER COLUMN is_text SET NOT NULL,
  ALTER COLUMN is_text SET DEFAULT false;

ALTER TABLE cas_blobs
  ADD CONSTRAINT cas_blobs_media_kind_check
    CHECK (media_kind IN ('text', 'image', 'audio', 'video', 'pdf', 'archive', 'json', 'document', 'binary'));
