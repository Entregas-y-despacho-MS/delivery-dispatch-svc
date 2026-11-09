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
    receipt?: PublishedReceipt;
}

/** One received item as Almacén reported it (ST-240.3); only those with a difference are published. */
export interface PublishedReceiptItem {
    itemCode?: string | null;
    packageId?: number | null;
    acceptedQuantity: number;
    missingQuantity: number;
    damagedQuantity: number;
    detail?: string | null;
}

/** Warehouse receipt result that closed the traslado, carried by `dispatch.transfer.status_changed`. */
export interface PublishedReceipt {
    result: 'complete' | 'with_differences' | 'rejected';
    items?: PublishedReceiptItem[];
}

const MAX_PUBLISHED_ITEMS = 500;
const MAX_ITEM_DETAIL_LENGTH = 500;

function receiptPayload(receipt: PublishedReceipt): Record<string, unknown> {
    const items = (receipt.items ?? [])
        .filter((item) => item.itemCode || item.packageId) // the contract needs exactly one identifier
        .filter((item) => item.missingQuantity > 0 || item.damagedQuantity > 0)
        .slice(0, MAX_PUBLISHED_ITEMS)
        .map((item) => ({
            ...(item.itemCode ? { itemCode: item.itemCode } : { packageId: item.packageId }),
            acceptedQuantity: item.acceptedQuantity,
            missingQuantity: item.missingQuantity,
            damagedQuantity: item.damagedQuantity,
            ...(item.detail ? { detail: item.detail.slice(0, MAX_ITEM_DETAIL_LENGTH) } : {}),
        }));
    return { result: receipt.result, ...(items.length > 0 ? { items } : {}) };
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
        ...(data.receipt ? receiptPayload(data.receipt) : {}),
    };
}
