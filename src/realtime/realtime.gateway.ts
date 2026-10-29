import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from './realtime.service';

type AuthedSocket = WebSocket & { userId?: string; expiryTimer?: NodeJS.Timeout; alive?: boolean };

/** Close codes the app can act on: 4401 means "get a new access token and reconnect". */
export const WS_UNAUTHORIZED = 4401;
const HEARTBEAT_MS = 30_000;

/**
 * One WebSocket per signed-in browser tab, at /ws (not under /api/v1). The access token is sent as ?token=<accessToken>
 * or in an "Authorization: Bearer" header. The connection closes with code 4401 when the token expires, so the app
 * refreshes it and reconnects. Messages are JSON: { "event": "...", "data": ... }.
 */
@WebSocketGateway({ path: '/ws' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger('Realtime');
  private readonly heartbeat: NodeJS.Timeout;
  private readonly clients = new Set<AuthedSocket>();

  constructor(
    private readonly jwt: JwtService,
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
  ) {
    // Drops connections that stopped answering pings (closed laptop, lost network).
    this.heartbeat = setInterval(() => {
      for (const s of this.clients) {
        if (s.alive === false) { s.terminate(); continue; }
        s.alive = false;
        s.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  async handleConnection(socket: AuthedSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    const header = req.headers.authorization;
    const token = url.searchParams.get('token') ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    try {
      if (!token) throw new Error('missing token');
      const payload = await this.jwt.verifyAsync<{ sub: string; exp: number }>(token);
      socket.userId = payload.sub;
      socket.alive = true;
      socket.on('pong', () => { socket.alive = true; });
      socket.expiryTimer = setTimeout(() => socket.close(WS_UNAUTHORIZED, 'token expired'), Math.max(0, payload.exp * 1000 - Date.now()));
      this.clients.add(socket);
      this.realtime.add(payload.sub, socket);
      socket.send(JSON.stringify({ event: 'ready', data: { userId: payload.sub } }));
    } catch {
      socket.close(WS_UNAUTHORIZED, 'invalid or missing access token');
    }
  }

  handleDisconnect(socket: AuthedSocket) {
    if (socket.expiryTimer) clearTimeout(socket.expiryTimer);
    this.clients.delete(socket);
    if (socket.userId) this.realtime.remove(socket.userId, socket);
  }

  /** { "event": "ping" } → { "event": "pong" }, for apps that want to check the connection. */
  @SubscribeMessage('ping')
  ping() {
    return { event: 'pong', data: { at: new Date().toISOString() } };
  }

  /**
   * { "event": "typing", "data": { "channelId": "..." } } → the channel's other members get
   * { "event": "typing", "data": { "channelId", "userId" } }. Only members of the channel can send it.
   */
  @SubscribeMessage('typing')
  async typing(@ConnectedSocket() socket: AuthedSocket, @MessageBody() data: { channelId?: unknown }) {
    const channelId = typeof data?.channelId === 'string' ? data.channelId : null;
    if (!socket.userId || !channelId || !/^[0-9a-f-]{36}$/i.test(channelId)) return;
    const members = await this.prisma.channelMember.findMany({ where: { channelId }, select: { userId: true } });
    if (!members.some((m) => m.userId === socket.userId)) return;
    this.realtime.emitToUsers(members.map((m) => m.userId).filter((id) => id !== socket.userId), 'typing', { channelId, userId: socket.userId });
  }

  onModuleDestroy() {
    clearInterval(this.heartbeat);
  }
}
