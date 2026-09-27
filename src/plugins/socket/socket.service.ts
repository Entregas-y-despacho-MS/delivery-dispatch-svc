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

    /**
     * Puts an already-connected socket into a room, so it starts receiving emitToRoom(room, ...).
     * The plugin doesn't decide which sockets join which room — a business module calls this (e.g.
     * from a SOCKET_CONNECTED_EVENT listener) with whatever rule is its own to decide.
     *
     * `in(socketId)` targets that one socket: every socket automatically joins a room named after
     * its own id on connect (a socket.io built-in), so this is the documented way to reach a specific
     * socket by id for a server-side operation — not `.sockets.get(id)`, whose declared type (`Server`
     * here, though the gateway actually hands us a namespaced instance) doesn't line up with what a
     * namespaced server returns at runtime for that property.
     */
    joinRoom(socketId: string, room: string): void {
        this.gateway.getServer().in(socketId).socketsJoin(room);
    }
}
