import { Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    INBOUND_MESSAGE_REJECTED_EVENT,
    InboundMessageRejection,
    type InboundRejectionNotice,
} from '../inbound-message-rejection.port.js';

/** In-memory alerts for local consumers; the business event follows the recorded alert. */
@Injectable()
export class MemoryInboundMessageRejectionAdapter extends InboundMessageRejection {
    readonly alerts: InboundRejectionNotice[] = [];

    constructor(@Optional() private readonly events?: EventEmitter2) {
        super();
    }

    async notify(notice: InboundRejectionNotice): Promise<void> {
        // The alert keeps what the real one persists: the payload only travels in the event below.
        const { message: _payload, ...alert } = notice;
        this.alerts.push({ ...alert, errors: [...notice.errors] });
        const { messageId, type, source, salesOrderId, reasonCode, rejectedAt } = notice;
        this.events?.emit('integration.message_rejected', {
            messageId,
            type,
            source,
            ...(salesOrderId !== undefined ? { salesOrderId } : {}),
            reasonCode,
            rejectedAt,
        });
        await this.events?.emitAsync(INBOUND_MESSAGE_REJECTED_EVENT, notice);
    }

    clear(): void {
        this.alerts.length = 0;
    }
}
