import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { DomainError } from './events.js';
import { isUuid, withIdempotency } from './idempotency.js';

export interface AppMutationContext {
  optionalOpId(body: unknown): string | undefined;
  runMutation<T>(args: {
    userId: string;
    opId?: string;
    opType: string;
    body: unknown;
    fn: (client: DbClient) => Promise<T>;
    onApplied?: (response: T) => void | Promise<void>;
  }): Promise<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function createAppMutationContext(pool: Db): AppMutationContext {
  function optionalOpId(body: unknown): string | undefined {
    if (!isPlainObject(body) || body.opId == null) return undefined;
    if (!isUuid(body.opId)) {
      throw new DomainError(400, 'bad_request', 'opId must be a uuid');
    }
    return body.opId;
  }

  async function runMutation<T>(args: {
    userId: string;
    opId?: string;
    opType: string;
    body: unknown;
    fn: (client: DbClient) => Promise<T>;
    onApplied?: (response: T) => void | Promise<void>;
  }): Promise<T> {
    if (args.opId) {
      return withIdempotency(
        pool,
        { userId: args.userId, opId: args.opId, opType: args.opType, body: args.body },
        args.fn,
        { onApplied: args.onApplied },
      );
    }
    const response = await withTx(pool, args.fn);
    if (args.onApplied) await args.onApplied(response);
    return response;
  }

  return { optionalOpId, runMutation };
}
