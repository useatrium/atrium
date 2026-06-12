import type { Db } from './db.js';

export async function pruneDraftTombstones(pool: Db): Promise<void> {
  await pool.query("DELETE FROM user_drafts WHERE deleted_at < now() - interval '30 days'");
}
