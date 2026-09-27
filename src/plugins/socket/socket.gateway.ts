import {
    OnGatewayConnection, OnGatewayDisconnect,
    WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../../app/auth/strategies/jwt.strategy.js';
import type { RoleEnum } from '../../shared/enums/index.js';
import { SOCKET_CONNECTED_EVENT } from './events/socket-connected.event.js';

// Read before class definition — the decorator needs the value at class-evaluation time,
// before NestJS DI is ready. dotenv is already loaded by main.ts at this point.
const NAMESPACE = process.env.WEBSOCKET_NAMESPACE ?? 'app';

@WebSocketGateway({ cors: { origin: '*' }, namespace: NAMESPACE })
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    // socketId → userId (from the verified token): tracks which socket belongs to which authenticated user.
    // Note: in-memory only — use @socket.io/redis-adapter for multi-instance deployments.
    private readonly clients = new Map<string, number>();

    constructor(
        private readonly jwt:          JwtService,
        private readonly config:      ConfigService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    /**
     * The client must present its access token (handshake `auth: { token }`, or an
     * `Authorization: Bearer` header). Without a valid one it is disconnected: the user id used to be a
     * self-declared `?userId=` query param, so anyone could connect and listen as any user.
     *
     * Announces the connection via SOCKET_CONNECTED_EVENT instead of deciding anything itself (e.g.
     * which room, if any, the socket should join for a given role) — that is business logic, and this
     * plugin stays generic, the same way mailer/pdf don't know about this domain either. Whoever cares
     * (e.g. app/tracking, for the 'dispatch-board' room) listens with @OnEvent(SOCKET_CONNECTED_EVENT).
     */
    handleConnection(client: Socket): void {
        const identity = this.authenticate(client);
        if (identity === null) {
            client.disconnect(true);
            return;
        }
        this.clients.set(client.id, identity.userId);
        this.eventEmitter.emit(SOCKET_CONNECTED_EVENT, { socketId: client.id, ...identity });
    }

    private authenticate(client: Socket): { userId: number; role: RoleEnum } | null {
        const fromAuth   = client.handshake.auth?.token;
        const fromHeader = client.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
        const token      = typeof fromAuth === 'string' ? fromAuth : fromHeader;
        if (!token) return null;
        try {
            const payload = this.jwt.verify<JwtPayload>(token, { secret: this.config.getOrThrow<string>('JWT_SECRET') });
            return typeof payload.sub === 'number' ? { userId: payload.sub, role: payload.role } : null;
        } catch {
            return null;
        }
    }

    handleDisconnect(client: Socket): void {
        this.clients.delete(client.id);
    }

    getServer()  { return this.server; }
    getClients() { return this.clients; }
}
