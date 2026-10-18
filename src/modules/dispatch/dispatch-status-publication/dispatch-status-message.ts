import { v5 } from 'uuid';

export const DISPATCH_TRANSFER_STATUS_CHANGED_TOPIC = 'dispatch.transfer.status_changed';

export const PUBLISHED_DELIVERY_OUTCOME_STATUSES: readonly string[] = [
    'delivered',
    'not_delivered',
    'incident',
    'returned',
    'cancelled',
];

const STATUS_MESSAGE_NAMESPACE = 'ff487b35-37d1-48fa-a6ad-a84632fe8164';

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

export function dispatchStatusMessageId(dispatchId: number, status: string, recordVersion: number): string {
    return v5(`${dispatchId}:${status}:${recordVersion}`, STATUS_MESSAGE_NAMESPACE);
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
