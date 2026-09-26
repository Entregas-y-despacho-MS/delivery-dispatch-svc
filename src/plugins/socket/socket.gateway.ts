import {
    OnGatewayConnection, OnGatewayDisconnect,
    WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../../app/auth/strategies/jwt.strategy.js';

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
        private readonly jwt:    JwtService,
        private readonly config: ConfigService,
    ) {}

    /**
     * The client must present its access token (handshake `auth: { token }`, or an
     * `Authorization: Bearer` header). Without a valid one it is disconnected: the user id used to be a
     * self-declared `?userId=` query param, so anyone could connect and listen as any user.
     */
    handleConnection(client: Socket): void {
        const userId = this.authenticate(client);
        if (userId === null) {
            client.disconnect(true);
            return;
        }
        this.clients.set(client.id, userId);
    }

    private authenticate(client: Socket): number | null {
        const fromAuth   = client.handshake.auth?.token;
        const fromHeader = client.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
        const token      = typeof fromAuth === 'string' ? fromAuth : fromHeader;
        if (!token) return null;
        try {
            const payload = this.jwt.verify<JwtPayload>(token, { secret: this.config.getOrThrow<string>('JWT_SECRET') });
            return typeof payload.sub === 'number' ? payload.sub : null;
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
