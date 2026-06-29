import { config } from '../src/config.js';
import { createPool } from '../src/db.js';
import {
  convergeExistingGitHubDirectGrant,
  convergeGitHubBrokerGrant,
  convergeGitHubPublicReadFallback,
} from '../src/github-iron-control.js';
import { IronControlAdminClient } from '../src/iron-control.js';

type Row = {
  workspace_id: string;
  user_id: string;
  status: string | null;
  token_kind: string | null;
  metadata: Record<string, unknown> | null;
};

const dryRun = process.argv.includes('--dry-run');
const apply = process.argv.includes('--apply');
if (!dryRun && !apply) {
  console.error(
    'usage: pnpm --filter @atrium/server exec tsx scripts/reconcile-github-connections.ts --dry-run|--apply',
  );
  process.exit(2);
}

const ironControl = new IronControlAdminClient({
  baseUrl: config.ironControlBaseUrl,
  apiKey: config.ironControlApiKey,
  namespace: config.ironControlNamespace,
});
if (!ironControl.configured) {
  console.error('IRON_CONTROL_BASE_URL and IRON_CONTROL_API_KEY are required');
  process.exit(2);
}

const pool = createPool(config.databaseUrl);
try {
  const rows = await pool.query<Row>(
    `SELECT wm.workspace_id,
            wm.user_id,
            uc.status,
            uc.token_kind,
            uc.metadata
       FROM workspace_members wm
       LEFT JOIN user_connections uc
         ON uc.workspace_id = wm.workspace_id
        AND uc.user_id = wm.user_id
        AND uc.provider = 'github'
      ORDER BY wm.workspace_id, wm.user_id`,
  );
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows.rows) {
    try {
      const action = await reconcileRow(row, dryRun);
      console.log(`${dryRun ? 'dry-run' : 'applied'} ${row.workspace_id}/${row.user_id}: ${action}`);
      if (action.startsWith('skipped')) skipped += 1;
      else ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`failed ${row.workspace_id}/${row.user_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(JSON.stringify({ ok, skipped, failed, dryRun }));
  process.exitCode = failed > 0 ? 1 : 0;
} finally {
  await pool.end();
}

async function reconcileRow(row: Row, dryRun: boolean): Promise<string> {
  const connected = row.status === 'connected';
  if (!connected) {
    if (!dryRun) {
      await convergeGitHubPublicReadFallback(ironControl, {
        workspaceId: row.workspace_id,
        userId: row.user_id,
      });
    }
    return 'fallback';
  }

  if (row.token_kind === 'app_installation' || row.token_kind === 'app_user') {
    const brokerCredentialId = stringValue(row.metadata?.brokerCredentialId);
    if (!brokerCredentialId) {
      throw new Error(`${row.token_kind} row is missing metadata.brokerCredentialId`);
    }
    if (!dryRun) {
      await convergeGitHubBrokerGrant(ironControl, {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        tokenKind: row.token_kind,
        brokerCredentialId,
      });
    }
    return `connected_${row.token_kind}`;
  }

  if (row.token_kind === 'pat') {
    if (!dryRun) {
      await convergeExistingGitHubDirectGrant(ironControl, {
        workspaceId: row.workspace_id,
        userId: row.user_id,
      });
    }
    return 'skipped_pat_verify_only';
  }

  throw new Error(`unsupported connected token_kind ${row.token_kind ?? '<null>'}`);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
