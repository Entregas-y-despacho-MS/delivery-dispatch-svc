import { Injectable } from '@nestjs/common';
import { InboundMessageLog, type InboundMessageRecord } from '../inbound-message-log.port.js';

@Injectable()
export class MemoryInboundMessageLogAdapter extends InboundMessageLog {
    private readonly records = new Map<string, InboundMessageRecord>();

    async wasProcessed(messageId: string): Promise<boolean> {
        return this.records.get(messageId)?.status === 'processed';
    }

    async record(record: InboundMessageRecord): Promise<boolean> {
        const existing = this.records.get(record.messageId);
        const replacesRejection = existing?.status === 'rejected' && record.status === 'processed';
        if (existing && !replacesRejection) return false;
        this.records.set(record.messageId, { ...record });
        return true;
    }

    /** Test helper: the stored receipt of a message. */
    get(messageId: string): InboundMessageRecord | undefined {
        return this.records.get(messageId);
    }

    /** Test helper. */
    clear(): void {
        this.records.clear();
    }
}
