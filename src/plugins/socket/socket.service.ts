import { Injectable } from '@nestjs/common';
import { SocketGateway } from './socket.gateway.js';

// High-level API for emitting WebSocket events from anywhere in the app.
// Business services import SocketService, not SocketGateway directly.
@Injectable()
export class SocketService {
    constructor(private readonly gateway: SocketGateway) {}

    /** Emits an event to all connected clients in the namespace. */
    emitToAll(event: string, data: unknown): void {
        this.gateway.getServer().emit(event, data);
    }

    /** Emits an event to all sockets belonging to a specific user (multiple tabs supported). */
    emitToUser(userId: number, event: string, data: unknown): void {
        this.gateway.getClients().forEach((storedId, socketId) => {
            if (storedId === userId) {
                this.gateway.getServer().to(socketId).emit(event, data);
            }
        });
    }

    /** Emits to all clients in a Socket.io room. Clients must have joined via socket.join(room). */
    emitToRoom(room: string, event: string, data: unknown): void {
        this.gateway.getServer().to(room).emit(event, data);
    }
}
