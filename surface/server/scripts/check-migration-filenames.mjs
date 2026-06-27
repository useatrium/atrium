#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

// Historical duplicates already applied in live/dev databases. These exact
// filename groups are allowed, but new duplicate prefixes or extra files inside
// one of these groups should fail; use the next number instead.
const allowedDuplicateGroups = new Map([
  ['014', ['014_auth_identity.sql', '014_centaur_idempotency.sql']],
  ['020', ['020_events_workspace_id.sql', '020_upload_content_hash.sql']],
  ['035', ['035_artifact_changes_writer_lock.sql', '035_provider_credentials.sql']],
  ['042', ['042_user_raw_access.sql', '042_workspace_scoped_artifacts.sql']],
]);
const nameRe = /^(\d{3})_[a-z0-9][a-z0-9_]*\.sql$/;

const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
const byPrefix = new Map();
const errors = [];

for (const file of files) {
  const match = nameRe.exec(file);
  if (!match) {
    errors.push(
      `${file}: expected migration filename format NNN_lower_snake_case.sql`,
    );
    continue;
  }
  const prefix = match[1];
  const group = byPrefix.get(prefix) ?? [];
  group.push(file);
  byPrefix.set(prefix, group);
}

for (const [prefix, group] of [...byPrefix.entries()].sort()) {
  if (group.length <= 1) continue;
  const allowed = allowedDuplicateGroups.get(prefix);
  if (allowed && sameList(group, allowed)) continue;
  errors.push(
    `${prefix}: duplicate migration prefix is not allowed (${group.join(', ')})`,
  );
}

for (const [prefix, allowed] of allowedDuplicateGroups) {
  const group = byPrefix.get(prefix);
  if (!group || !sameList(group, allowed)) {
    errors.push(
      `${prefix}: allowed duplicate prefix is stale; remove it from check-migration-filenames.mjs`,
    );
  }
}

if (errors.length > 0) {
  console.error('Migration filename check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`migration filenames ok (${files.length} files)`);

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
