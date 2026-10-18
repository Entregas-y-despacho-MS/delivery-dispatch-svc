import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SocketService } from '../../plugins/socket/socket.service.js';
import { DISPATCH_BOARD_ROOM } from '../tracking/services/tracking.service.js';
import { DISPATCH_STATUS_CHANGED_EVENT } from './dispatch-status-changed.event.js';
import type { DispatchStatusChangedEvent } from './dispatch-status-changed.event.js';

@Injectable()
export class DispatchStatusSocketListener {
    constructor(private readonly socket: SocketService) {}

    @OnEvent(DISPATCH_STATUS_CHANGED_EVENT, { async: true })
    handleStatusChanged(event: DispatchStatusChangedEvent): void {
        this.socket.emitToRoom(DISPATCH_BOARD_ROOM, DISPATCH_STATUS_CHANGED_EVENT, event);
    }
}
