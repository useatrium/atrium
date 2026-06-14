import type { UserRef, WireEvent } from './events.js';

type CallEvent =
  | { type: 'call.ringing'; call: object }
  | { type: 'call.accepted'; callId: string; user: UserRef }
  | { type: 'call.declined'; callId: string; userId: string }
  | { type: 'call.participant_joined'; callId: string; user: UserRef }
  | { type: 'call.participant_left'; callId: string; userId: string }
  | { type: 'call.ended'; callId: string };

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
  /** Channel the user is actively viewing — drives channel presence. */
  focusedChannelId: string | null;
  isAlive: boolean;
  nextSeq: number;
}

/** `session:<id>` keys are subscribed only while the pane is open. */
function isSessionKey(key: string): boolean {
  return key.startsWith('session:');
}

/**
 * In-memory fanout + presence.
 * - Channel presence = unique users among sockets *focused* on that channel
 *   (viewing it), not merely subscribed — every client subscribes to every
 *   channel for event fanout, so subscription-based counts were pure noise.
 * - `session:<id>` presence stays subscription-based: clients subscribe that
 *   key only while the pane is open, which already means "watching".
 */
export class WsHub {
  private clients = new Set<HubClient>();

  addClient(socket: HubSocket, user: UserRef): HubClient {
    const client: HubClient = {
      socket,
      user,
      channels: new Set(),
      focusedChannelId: null,
      isAlive: true,
      nextSeq: 1,
    };
    this.clients.add(client);
    return client;
  }

  removeClient(client: HubClient): void {
    if (!this.clients.delete(client)) return;
    for (const channelId of client.channels) this.broadcastPresence(channelId);
    if (client.focusedChannelId && !client.channels.has(client.focusedChannelId)) {
      this.broadcastPresence(client.focusedChannelId);
    }
  }

  /** Move a client's viewing focus; emit presence for both affected channels. */
  setFocus(client: HubClient, channelId: string | null): void {
    const prev = client.focusedChannelId;
    if (prev === channelId) return;
    client.focusedChannelId = channelId;
    if (prev) this.broadcastPresence(prev);
    if (channelId) this.broadcastPresence(channelId);
  }

  private isMember(client: HubClient, key: string): boolean {
    return isSessionKey(key) ? client.channels.has(key) : client.focusedChannelId === key;
  }

  /** Ephemeral typing relay to everyone else viewing the channel. */
  relayTyping(from: HubClient, channelId: string): void {
    for (const client of this.clients) {
      if (client !== from && client.focusedChannelId === channelId) {
        this.sendTo(client, { type: 'typing', channelId, user: from.user });
      }
    }
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
    for (const client of this.clients) {
      if (client.channels.has(event.channelId)) this.sendTo(client, { type: 'event', event });
    }
  }

  /** Send an event only to specific users' sockets (e.g. DM creation). */
  publishToUsers(userIds: string[], event: WireEvent): void {
    const ids = new Set(userIds);
    for (const client of this.clients) {
      if (ids.has(client.user.id)) this.sendTo(client, { type: 'event', event });
    }
  }

  sendToUsers(userIds: string[], payload: object): void {
    const ids = new Set(userIds);
    for (const client of this.clients) {
      if (ids.has(client.user.id)) this.sendTo(client, payload);
    }
  }

  // === call additions ===
  /** Ephemeral call lifecycle relay; frames are not persisted timeline events. */
  publishCallToUsers(userIds: string[], event: CallEvent): void {
    const ids = new Set(userIds);
    for (const client of this.clients) {
      if (ids.has(client.user.id)) this.sendTo(client, event);
    }
  }

  presenceFor(channelId: string): UserRef[] {
    const byId = new Map<string, UserRef>();
    for (const client of this.clients) {
      if (this.isMember(client, channelId)) byId.set(client.user.id, client.user);
    }
    return [...byId.values()].sort((a, b) => a.handle.localeCompare(b.handle));
  }

  isUserPresent(channelId: string, userId: string): boolean {
    for (const client of this.clients) {
      if (client.user.id === userId && this.isMember(client, channelId)) return true;
    }
    return false;
  }

  private presenceMessage(channelId: string): object {
    return { type: 'presence', channelId, users: this.presenceFor(channelId) };
  }

  broadcastPresence(channelId: string): void {
    for (const client of this.clients) {
      if (client.channels.has(channelId)) this.sendTo(client, this.presenceMessage(channelId));
    }
  }

  sendTo(client: HubClient, payload: object): void {
    if (client.socket.readyState === OPEN) {
      const frame = { ...payload, seq: client.nextSeq++ };
      try {
        client.socket.send(JSON.stringify(frame));
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
