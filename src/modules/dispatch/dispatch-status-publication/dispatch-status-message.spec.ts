import { describe, expect, it } from 'vitest';
import {
    dispatchStatusMessageId,
    dispatchStatusMessagePayload,
    PUBLISHED_DELIVERY_OUTCOME_STATUSES,
} from './dispatch-status-message.js';

describe('dispatch transfer status-changed message', () => {
    it('uses a stable id for dispatch, resulting status and record version', () => {
        const first = dispatchStatusMessageId(42, 'delivered', 3);
        expect(dispatchStatusMessageId(42, 'delivered', 3)).toBe(first);
        expect(dispatchStatusMessageId(42, 'returned', 3)).not.toBe(first);
        expect(dispatchStatusMessageId(42, 'delivered', 4)).not.toBe(first);
        expect(dispatchStatusMessageId(43, 'delivered', 3)).not.toBe(first);
    });

    it('publishes the order identity, transport result and optional reason without personal data', () => {
        expect(dispatchStatusMessagePayload({
            dispatchId: 42,
            dispatchType: 'delivery',
            sourceOrderRef: 'SO-2026-123',
            trackingCode: 'DSP-2026-00042',
            status: 'not_delivered',
            previousStatus: 'in_transit',
            occurredAt: '2026-10-18T10:00:00.000Z',
            recordVersion: 3,
            reasonCode: 'INC-CUST-ABSENT',
        })).toEqual({
            salesOrderId: 'SO-2026-123',
            trackingCode: 'DSP-2026-00042',
            status: 'not_delivered',
            previousStatus: 'in_transit',
            occurredAt: '2026-10-18T10:00:00.000Z',
            recordVersion: 3,
            reasonCode: 'INC-CUST-ABSENT',
        });
    });

    it('uses purchaseOrderId for supplier operations and omits an absent reason code', () => {
        const payload = dispatchStatusMessagePayload({
            dispatchId: 57,
            dispatchType: 'supplier_pickup',
            sourceOrderRef: 'PO-2026-57',
            trackingCode: 'DSP-2026-00057',
            status: 'returned',
            previousStatus: 'picked_up_in_transit',
            occurredAt: '2026-10-18T10:00:00.000Z',
            recordVersion: 1,
        });
        expect(payload).toHaveProperty('purchaseOrderId', 'PO-2026-57');
        expect(payload).not.toHaveProperty('salesOrderId');
        expect(payload).not.toHaveProperty('reasonCode');
    });

    it('lists each result status requested by ST-73.3', () => {
        expect(PUBLISHED_DELIVERY_OUTCOME_STATUSES).toEqual([
            'delivered', 'not_delivered', 'incident', 'returned', 'cancelled',
        ]);
    });
});
