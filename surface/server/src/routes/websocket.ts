import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { canAccessChannel, type UserRef } from '../events.js';
import type { WsHub } from '../hub.js';
import type { SessionRuns } from '../session-runs.js';

export interface WebsocketRouteDeps {
  pool: Db;
  hub: WsHub;
  sessionRuns: SessionRuns;
  userFromSession(raw: string | undefined | null): Promise<UserRef | null>;
  userFromRequest(req: FastifyRequest): Promise<UserRef | null>;
}

export function registerWebsocketRoutes(app: FastifyInstance, deps: WebsocketRouteDeps): void {
  const { pool, hub, sessionRuns, userFromSession, userFromRequest } = deps;

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true, config: { rateLimit: false } }, (socket, req) => {
      // Handlers must attach synchronously: clients send subscribe/focus the
      // moment the socket opens, and frames that arrive while auth is still
      // awaiting the DB would otherwise be dropped on the floor (the client
      // would then sit on a "live" socket subscribed to nothing). Buffer
      // frames until auth resolves, then replay.
      let client: ReturnType<WsHub['addClient']> | null = null;
      const preAuth: Buffer[] = [];

      const handleMessage = (user: UserRef, raw: Buffer) => {
        if (!client) return;
        const c = client;
        let msg: { type?: string; channelIds?: unknown; channelId?: unknown; sessionId?: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'subscribe' && Array.isArray(msg.channelIds)) {
          const ids = msg.channelIds.filter((v): v is string => typeof v === 'string').slice(0, 500);
          // Member-only channels (and session: presence keys) drop ids the
          // user can't access so fanout/presence can trust subscriptions. A
          // session: key is gated on the session's channel — otherwise a
          // non-member could appear as a watcher of a foreign private session.
          void (async () => {
            const allowed: string[] = [];
            for (const id of ids) {
              const ok = id.startsWith('session:')
                ? await sessionRuns.userCanAccessSession(id.slice('session:'.length), user.id)
                : await canAccessChannel(pool, user.id, id);
              if (ok) allowed.push(id);
            }
            hub.subscribe(c, allowed);
          })().catch(() => {});
        } else if (msg.type === 'focus') {
          const channelId = typeof msg.channelId === 'string' ? msg.channelId : null;
          if (!channelId) {
            hub.setFocus(c, null);
          } else {
            void canAccessChannel(pool, user.id, channelId)
              .then((ok) => {
                if (ok) hub.setFocus(c, channelId);
              })
              .catch(() => {});
          }
        } else if (msg.type === 'typing') {
          // Session typing fans out over the `session:<id>` subscription
          // (relaySessionTyping re-checks the sender is watching it); otherwise
          // it's channel typing, gated on focus (access-checked) so nobody can
          // signal into a DM they aren't reading.
          if (typeof msg.sessionId === 'string') {
            hub.relaySessionTyping(c, msg.sessionId);
          } else if (typeof msg.channelId === 'string' && c.focusedChannelId === msg.channelId) {
            hub.relayTyping(c, msg.channelId);
          }
        } else if (msg.type === 'ping') {
          hub.sendTo(c, { type: 'pong', t: Date.now() });
        }
      };

      let authedUser: UserRef | null = null;
      socket.on('message', (raw: Buffer) => {
        if (authedUser) handleMessage(authedUser, raw);
        else preAuth.push(raw);
      });
      socket.on('pong', () => {
        if (client) client.isAlive = true;
      });
      const cleanup = () => {
        if (client) hub.removeClient(client);
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);

      void (async () => {
        // Browsers authenticate the upgrade with the session cookie; native
        // clients can't set headers on WebSocket, so accept ?token= too.
        const q = (req.query ?? {}) as { token?: unknown };
        const user =
          (typeof q.token === 'string' ? await userFromSession(q.token) : null) ??
          (await userFromRequest(req as FastifyRequest));
        if (!user) {
          socket.close(4401, 'unauthorized');
          return;
        }
        if (socket.readyState !== socket.OPEN) return; // closed while authing
        client = hub.addClient(socket, user);
        authedUser = user;
        for (const raw of preAuth.splice(0)) handleMessage(user, raw);
      })().catch(() => socket.close(1011, 'auth error'));
    });
  });
}
