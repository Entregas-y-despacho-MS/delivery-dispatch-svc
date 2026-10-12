import { Injectable } from '@nestjs/common';
import { ConsolidationRecord, type ConsolidationMark } from '../ports/consolidation-record.port.js';

/** In-memory `ConsolidationRecord` for the tests of the consumers. */
@Injectable()
export class MemoryConsolidationRecord extends ConsolidationRecord {
    private readonly marks = new Map<string, ConsolidationMark>();

    async find(salesOrderId: string): Promise<ConsolidationMark | null> {
        const mark = this.marks.get(salesOrderId);
        return mark ? { ...mark } : null;
    }

    async mark(salesOrderId: string, mark: ConsolidationMark): Promise<void> {
        this.marks.set(salesOrderId, { ...mark });
    }
}
