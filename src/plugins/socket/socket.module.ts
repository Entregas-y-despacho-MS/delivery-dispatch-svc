import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
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
    // Only used to verify the access token of a connecting client (the secret is read from JWT_SECRET).
    imports:   [JwtModule.register({})],
    providers: [SocketGateway, SocketService],
    exports:   [SocketService],
})
export class SocketModule {}
