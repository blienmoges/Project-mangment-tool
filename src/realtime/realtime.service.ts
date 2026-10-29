import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

/** Open WebSocket connections per user, and pushes to them (API Design, "Real-time events"). */
@Injectable()
export class RealtimeService {
  private readonly sockets = new Map<string, Set<WebSocket>>();

  add(userId: string, socket: WebSocket) {
    if (!this.sockets.has(userId)) this.sockets.set(userId, new Set());
    this.sockets.get(userId)!.add(socket);
  }

  remove(userId: string, socket: WebSocket) {
    const set = this.sockets.get(userId);
    set?.delete(socket);
    if (set && !set.size) this.sockets.delete(userId);
  }

  /** Sends { "event": ..., "data": ... } to every open connection of the user. Returns how many received it. */
  emitToUser(userId: string, event: string, data: unknown) {
    const message = JSON.stringify({ event, data });
    let sent = 0;
    for (const socket of this.sockets.get(userId) ?? []) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        sent++;
      }
    }
    return sent;
  }

  /** Same as emitToUser for several people (duplicates ignored). */
  emitToUsers(userIds: Iterable<string>, event: string, data: unknown) {
    let sent = 0;
    for (const id of new Set(userIds)) sent += this.emitToUser(id, event, data);
    return sent;
  }

  isOnline(userId: string) {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  connectionCount() {
    let n = 0;
    for (const set of this.sockets.values()) n += set.size;
    return n;
  }
}
