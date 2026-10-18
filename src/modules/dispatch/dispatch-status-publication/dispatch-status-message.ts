import { createHash } from 'node:crypto';

export const DISPATCH_TRANSFER_STATUS_CHANGED_TOPIC = 'dispatch.transfer.status_changed';

export const PUBLISHED_DELIVERY_OUTCOME_STATUSES: readonly string[] = [
    'delivered',
    'not_delivered',
    'incident',
    'returned',
    'cancelled',
];

export interface DispatchStatusMessageData {
    dispatchId: number;
    dispatchType: string;
    sourceOrderRef: string;
    trackingCode: string;
    status: string;
    previousStatus: string;
    occurredAt: string;
    recordVersion: number;
    reasonCode?: string;
}

export function dispatchStatusMessageId(dispatchId: number, status: string, recordVersion: number, occurredAt: Date): string {
    // Deterministic UUIDv7: contract-compatible and stable for the idempotency tuple.
    const timestamp = Math.max(0, Math.trunc(occurredAt.getTime())).toString(16).slice(-12).padStart(12, '0');
    const entropy = createHash('sha256').update(`${dispatchId}:${status}:${recordVersion}`).digest('hex');
    const randA = ((Number.parseInt(entropy.slice(0, 3), 16) & 0x0fff) | 0x7000).toString(16);
    const randB = ((Number.parseInt(entropy.slice(3, 6), 16) & 0x3fff) | 0x8000).toString(16);
    return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-${randA}-${randB}-${entropy.slice(6, 18)}`;
}

export function dispatchStatusMessagePayload(data: DispatchStatusMessageData): Record<string, unknown> {
    const orderIdentity = data.dispatchType === 'supplier_pickup' || data.dispatchType === 'supplier_return'
        ? { purchaseOrderId: data.sourceOrderRef }
        : { salesOrderId: data.sourceOrderRef };

    return {
        ...orderIdentity,
        trackingCode: data.trackingCode,
        status: data.status,
        previousStatus: data.previousStatus,
        occurredAt: data.occurredAt,
        recordVersion: data.recordVersion,
        ...(data.reasonCode ? { reasonCode: data.reasonCode } : {}),
    };
}
