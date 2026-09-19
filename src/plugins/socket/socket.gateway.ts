import {
    OnGatewayConnection, OnGatewayDisconnect,
    WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

// Read before class definition — the decorator needs the value at class-evaluation time,
// before NestJS DI is ready. dotenv is already loaded by main.ts at this point.
const NAMESPACE = process.env.WEBSOCKET_NAMESPACE ?? 'app';

@WebSocketGateway({ cors: { origin: '*' }, namespace: NAMESPACE })
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    // socketId → userId: tracks which socket belongs to which authenticated user.
    // Note: in-memory only — use @socket.io/redis-adapter for multi-instance deployments.
    private readonly clients = new Map<string, number>();

    handleConnection(client: Socket): void {
        // Client must pass ?userId=123 in the handshake query.
        const userId = Number(client.handshake.query?.userId ?? 0);
        if (userId) this.clients.set(client.id, userId);
    }

    handleDisconnect(client: Socket): void {
        this.clients.delete(client.id);
    }

    getServer()  { return this.server; }
    getClients() { return this.clients; }
}
