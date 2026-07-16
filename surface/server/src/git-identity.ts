import type { Db, DbClient } from './db.js';

export interface GitIdentity {
  authorName: string;
  authorEmail: string;
  source: 'github_noreply' | 'atrium_account';
  sessionId: string;
  harness: string;
}

interface GitIdentityRow {
  session_id: string;
  harness: string;
  display_name: string;
  account_login: string | null;
  account_id: string | null;
  email: string | null;
}

type Queryable = Pick<Db | DbClient, 'query'>;

export async function resolveGitIdentity(pool: Queryable, sessionId: string): Promise<GitIdentity | null> {
  const result = await pool.query<GitIdentityRow>(
    `SELECT s.id AS session_id,
            s.harness,
            u.display_name,
            i.account_login,
            i.account_id,
            u.email
       FROM sessions s
       JOIN users u ON u.id = COALESCE(s.provider_credential_user_id, s.spawned_by)
       LEFT JOIN user_connection_identities i
         ON i.workspace_id = s.workspace_id
        AND i.user_id = u.id
        AND i.provider = 'github'
        AND i.active
        AND i.status = 'connected'
      WHERE s.id = $1
      LIMIT 1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const accountLogin = nonEmpty(row.account_login);
  const accountId = nonEmpty(row.account_id);
  const atriumEmail = nonEmpty(row.email);
  const authorName = nonEmpty(row.display_name) ?? accountLogin ?? emailLocalPart(atriumEmail) ?? 'Atrium User';

  if (accountLogin && accountId) {
    return {
      authorName,
      authorEmail: `${accountId}+${accountLogin}@users.noreply.github.com`,
      source: 'github_noreply',
      sessionId: row.session_id,
      harness: row.harness,
    };
  }
  if (atriumEmail) {
    return {
      authorName,
      authorEmail: atriumEmail,
      source: 'atrium_account',
      sessionId: row.session_id,
      harness: row.harness,
    };
  }
  return null;
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function emailLocalPart(email: string | null): string | null {
  if (!email) return null;
  return nonEmpty(email.split('@', 1)[0] ?? null);
}
