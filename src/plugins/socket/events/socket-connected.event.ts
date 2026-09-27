import type { RoleEnum } from '../../../shared/enums/index.js';

// Event name used with @nestjs/event-emitter (EventEmitter2). The plugin only announces "someone
// authenticated connected" — it does not decide what happens next (which room they join, if any).
// That decision belongs to whichever business module cares (e.g. app/tracking), via @OnEvent(SOCKET_CONNECTED_EVENT).
export const SOCKET_CONNECTED_EVENT = 'socket.connected';

export interface SocketConnectedEvent {
    socketId: string;
    userId:   number;
    role:     RoleEnum;
}
