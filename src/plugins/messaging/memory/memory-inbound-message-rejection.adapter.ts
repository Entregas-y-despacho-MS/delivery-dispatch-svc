import { Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
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
        this.alerts.push({ ...notice, errors: [...notice.errors] });
        const { messageId, type, source, salesOrderId, reasonCode, rejectedAt } = notice;
        this.events?.emit('integration.message_rejected', {
            messageId,
            type,
            source,
            ...(salesOrderId !== undefined ? { salesOrderId } : {}),
            reasonCode,
            rejectedAt,
        });
    }

    clear(): void {
        this.alerts.length = 0;
    }
}
