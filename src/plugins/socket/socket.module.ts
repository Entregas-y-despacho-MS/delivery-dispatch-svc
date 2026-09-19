import { Global, Module } from '@nestjs/common';
import { SocketGateway } from './socket.gateway.js';
import { SocketService } from './socket.service.js';

/**
 * Plugin WebSocket — autocontenido.
 * Para eliminar:
 *   1. Borra plugins/socket/
 *   2. Quita SocketModule del AppModule
 *   3. Elimina WEBSOCKET_NAMESPACE de config/env.validation.ts
 */
@Global()
@Module({
    providers: [SocketGateway, SocketService],
    exports:   [SocketService],
})
export class SocketModule {}
