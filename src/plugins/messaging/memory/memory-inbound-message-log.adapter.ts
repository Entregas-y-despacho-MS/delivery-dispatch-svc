import { Injectable } from '@nestjs/common';
import { InboundMessageLog, type InboundMessageRecord } from '../inbound-message-log.port.js';

@Injectable()
export class MemoryInboundMessageLogAdapter extends InboundMessageLog {
    private readonly records = new Map<string, InboundMessageRecord>();

    async exists(messageId: string): Promise<boolean> {
        return this.records.has(messageId);
    }

    async record(record: InboundMessageRecord): Promise<boolean> {
        if (this.records.has(record.messageId)) return false;
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
