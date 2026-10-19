import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SocketService } from '../../plugins/socket/socket.service.js';
import { DISPATCH_BOARD_ROOM } from '../tracking/services/tracking.service.js';
import { DISPATCH_EVIDENCE_REGISTERED_EVENT } from './dispatch-evidence-registered.event.js';
import type { DispatchEvidenceRegisteredEvent } from './dispatch-evidence-registered.event.js';

// Lets the control tower see a new proof of delivery without refreshing. It carries no file or code.
@Injectable()
export class DispatchEvidenceSocketListener {
    constructor(private readonly socket: SocketService) {}

    @OnEvent(DISPATCH_EVIDENCE_REGISTERED_EVENT, { async: true })
    handleEvidenceRegistered(event: DispatchEvidenceRegisteredEvent): void {
        this.socket.emitToRoom(DISPATCH_BOARD_ROOM, DISPATCH_EVIDENCE_REGISTERED_EVENT, event);
    }
}
