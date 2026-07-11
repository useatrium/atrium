import type { Db } from './db.js';
import { ArtifactLedger } from './artifact-ledger.js';

export interface CasStorage {
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  getObjectBytes: (key: string) => Promise<Buffer>;
  headObject?: (key: string) => Promise<{ contentLength: number } | null>;
}

export async function persistCasBlob(
  pool: Db,
  storage: Pick<CasStorage, 'uploadObject' | 'headObject'>,
  args: { sha256: string; key: string; bytes: Buffer },
): Promise<void> {
  const ledger = new ArtifactLedger(pool);
  if (await ledger.blobIsDurable(args.sha256)) return;

  const exists = storage.headObject ? await storage.headObject(args.key) : null;
  if (!exists) await storage.uploadObject(args.key, args.bytes, 'application/octet-stream');
  await pool.query(
    `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ($1, $2, $3, 'application/octet-stream')
     ON CONFLICT (sha256) DO UPDATE SET
       s3_key = COALESCE(cas_blobs.s3_key, EXCLUDED.s3_key),
       size_bytes = GREATEST(cas_blobs.size_bytes, EXCLUDED.size_bytes)`,
    [args.sha256, args.key, args.bytes.length],
  );
}

export async function loadCasBlob(
  pool: Db,
  storage: Pick<CasStorage, 'getObjectBytes'>,
  sha256: string,
): Promise<Buffer | null> {
  const row = await pool.query<{ s3_key: string | null }>('SELECT s3_key FROM cas_blobs WHERE sha256 = $1', [sha256]);
  const key = row.rows[0]?.s3_key;
  if (!key) return null;
  try {
    return await storage.getObjectBytes(key);
  } catch {
    return null;
  }
}
