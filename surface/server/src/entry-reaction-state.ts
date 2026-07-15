import type { DbClient } from './db.js';

export async function refoldEntryReactions(client: DbClient, target: string): Promise<void> {
  await client.query('SELECT refold_entry_reactions($1)', [target]);
}
