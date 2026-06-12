# Data Lifecycle

The `events` table is append-only by design. Message posts, edits, deletes, reactions, channel changes, and related timeline facts remain in the log so clients can sync from an event id watermark and rebuild local state deterministically. There is no event pruning today. Growth is roughly one event per message plus follow-on edit, delete, reaction, and system events. A future archival path should preserve sync semantics by taking a snapshot before archive, then partitioning or moving events below a chosen `id` watermark into cheaper storage.

Idempotency keys are short-lived replay guards. The server deletes keys older than 7 days at startup and every 24 hours.

Uploaded file metadata lives in `files`; object bodies live in S3-compatible storage. Files are created before a message references them, so abandoned uploads can leave orphan rows and objects. The server prunes file rows older than `ATRIUM_FILE_GC_DAYS` days, defaulting to 7. Set `ATRIUM_FILE_GC_DAYS=0` to disable this sweep. A file is kept if any `message.posted` event payload contains its id in `attachments`, even if the message is later edited or deleted by tombstone events. The sweep deletes the S3 object first, treats `NoSuchKey` or HTTP 404 as already deleted, and removes the `files` row only after object deletion succeeds or the object is already missing. Other storage errors keep the row for the next sweep.

Draft tombstone cleanup is out of scope for this lifecycle pass.
