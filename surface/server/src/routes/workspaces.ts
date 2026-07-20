import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Schema } from 'effect';
import type { Db } from '../db.js';
import { createWorkspace, type UserRef, type Workspace } from '../events.js';
import { addWorkspaceMember, isWorkspaceMember } from '../membership.js';
import { isUuid } from '../idempotency.js';
import { decodeRouteBody } from '../route-schema.js';
import { userRefFromRow } from '../user-ref.js';

const CreateWorkspaceBodySchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
});

const AddWorkspaceMemberBodySchema = Schema.Struct({
  handle: Schema.optional(Schema.Unknown),
});

export interface WorkspaceRouteDeps {
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  const { pool, requireUser } = deps;

  app.get('/api/workspaces', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const res = await pool.query<{ id: string; name: string; created_at: Date }>(
      `SELECT w.id, w.name, w.created_at
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = $1
       ORDER BY wm.created_at ASC, w.id ASC`,
      [user.id],
    );
    return {
      workspaces: res.rows.map(
        (r): Workspace => ({
          id: r.id,
          name: r.name,
          createdAt: new Date(r.created_at).toISOString(),
        }),
      ),
    };
  });

  app.post('/api/workspaces', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = decodeRouteBody(CreateWorkspaceBodySchema, req.body);
    const name = String(body.name ?? '').trim();
    if (name.length < 1 || name.length > 64) {
      return reply.code(400).send({ error: 'invalid_workspace_name', message: 'workspace name must be 1-64 chars' });
    }
    try {
      const { workspace } = await createWorkspace(pool, { name, actorId: user.id });
      await addWorkspaceMember(pool, workspace.id, user.id);
      return reply.code(201).send({ workspace });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'workspace_exists', message: 'workspace name already exists' });
      }
      throw err;
    }
  });

  app.post('/api/workspaces/:id/members', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!isUuid(id) || !(await isWorkspaceMember(pool, user.id, id))) {
      return reply.code(404).send({ error: 'workspace_not_found', message: 'workspace not found' });
    }
    const body = decodeRouteBody(AddWorkspaceMemberBodySchema, req.body);
    const handle = String(body.handle ?? '')
      .trim()
      .toLowerCase();
    const target = await pool.query<{
      id: string;
      handle: string;
      display_name: string;
      avatar_s3_key: string | null;
      avatar_version: number;
    }>(
      'SELECT id, handle, display_name, avatar_s3_key, avatar_version FROM users WHERE handle = $1',
      [handle],
    );
    const member = target.rows[0];
    if (!member) {
      return reply.code(404).send({ error: 'user_not_found', message: 'user not found' });
    }
    await addWorkspaceMember(pool, id, member.id);
    return {
      member: userRefFromRow(member),
    };
  });
}
