import type { UserRef, WireEvent } from './events.js';

/** Minimal socket surface the hub needs (real ws.WebSocket satisfies this). */
export interface HubSocket {
  readyState: number;
  send(data: string): void;
  ping?(): void;
  terminate?(): void;
}

const OPEN = 1;

export interface HubClient {
  socket: HubSocket;
  user: UserRef;
  channels: Set<string>;
  isAlive: boolean;
}

/**
 * In-memory fanout + presence. Presence for a channel = unique users among
 * currently-connected sockets subscribed to that channel.
 */
export class WsHub {
  private clients = new Set<HubClient>();

  addClient(socket: HubSocket, user: UserRef): HubClient {
    const client: HubClient = { socket, user, channels: new Set(), isAlive: true };
    this.clients.add(client);
    return client;
  }

  removeClient(client: HubClient): void {
    if (!this.clients.delete(client)) return;
    for (const channelId of client.channels) this.broadcastPresence(channelId);
  }

  /** Replace a client's subscription set; emit presence for changed channels. */
  subscribe(client: HubClient, channelIds: string[]): void {
    const next = new Set(channelIds);
    const changed = new Set<string>();
    for (const id of client.channels) if (!next.has(id)) changed.add(id);
    for (const id of next) if (!client.channels.has(id)) changed.add(id);
    client.channels = next;
    for (const id of changed) this.broadcastPresence(id);
    // Always give the subscriber a fresh snapshot of every channel it watches
    // (broadcastPresence above only covers channels whose membership changed).
    for (const id of next) {
      if (!changed.has(id)) this.sendTo(client, this.presenceMessage(id));
    }
  }

  publishEvent(event: WireEvent): void {
    if (!event.channelId) return;
    const msg = JSON.stringify({ type: 'event', event });
    for (const client of this.clients) {
      if (client.channels.has(event.channelId)) this.sendRaw(client, msg);
    }
  }

  /** Broadcast to every connected client regardless of subscriptions. */
  publishGlobal(event: WireEvent): void {
    const msg = JSON.stringify({ type: 'event', event });
    for (const client of this.clients) this.sendRaw(client, msg);
  }

  presenceFor(channelId: string): UserRef[] {
    const byId = new Map<string, UserRef>();
    for (const client of this.clients) {
      if (client.channels.has(channelId)) byId.set(client.user.id, client.user);
    }
    return [...byId.values()].sort((a, b) => a.handle.localeCompare(b.handle));
  }

  isUserPresent(channelId: string, userId: string): boolean {
    for (const client of this.clients) {
      if (client.user.id === userId && client.channels.has(channelId)) return true;
    }
    return false;
  }

  private presenceMessage(channelId: string): object {
    return { type: 'presence', channelId, users: this.presenceFor(channelId) };
  }

  broadcastPresence(channelId: string): void {
    const msg = JSON.stringify(this.presenceMessage(channelId));
    for (const client of this.clients) {
      if (client.channels.has(channelId)) this.sendRaw(client, msg);
    }
  }

  sendTo(client: HubClient, payload: object): void {
    this.sendRaw(client, JSON.stringify(payload));
  }

  private sendRaw(client: HubClient, msg: string): void {
    if (client.socket.readyState === OPEN) {
      try {
        client.socket.send(msg);
      } catch {
        // socket died mid-send; heartbeat will reap it
      }
    }
  }

  /** Protocol-level ping sweep; terminates sockets that missed a pong. */
  startHeartbeat(intervalMs = 30_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.socket.terminate?.();
          this.removeClient(client);
          continue;
        }
        client.isAlive = false;
        try {
          client.socket.ping?.();
        } catch {
          /* reaped next sweep */
        }
      }
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  get size(): number {
    return this.clients.size;
  }
}
