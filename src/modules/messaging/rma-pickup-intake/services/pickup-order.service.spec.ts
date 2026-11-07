import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { RejectedMessageException } from '../../../../plugins/messaging/exceptions/rejected-message.exception.js';
import type { RmaPickupRequestedData } from '../domain/rma-pickup-message.types.js';
import { PickupOrderService } from './pickup-order.service.js';

const data: RmaPickupRequestedData = {
    rmaId: 'RMA-1',
    recordVersion: 1,
    updatedAt: '2026-11-03T14:00:00Z',
    approvedAt: '2026-11-03T13:00:00Z',
    warehouseId: 'WH-LPZ-01',
    contact: { name: 'Cliente Uno', phone: '77712345' },
    pickupAddress: { line: 'Av. Siempre Viva 123', location: { latitude: -17.78, longitude: -63.18 } },
    returnReason: 'Producto defectuoso',
    packages: [{ packageId: 'PKG-1', lengthCm: 30, widthCm: 20, heightCm: 15, grossWeightKg: 4.5 }],
};

describe('PickupOrderService', () => {
    const service = new PickupOrderService();

    it('rejects an unknown warehouse before writing anything', async () => {
        const query = vi.fn().mockResolvedValueOnce([]); // warehouse lookup: not found

        await expect(service.createFromRma(data, { manager: { query } as unknown as EntityManager })).rejects.toBeInstanceOf(RejectedMessageException);

        expect(query).toHaveBeenCalledTimes(1);
    });

    it('rejects an rmaId with the reserved MANUAL- prefix before touching the database', async () => {
        const query = vi.fn();

        const error = await service
            .createFromRma({ ...data, rmaId: 'MANUAL-DSP-2026-00001' }, { manager: { query } as unknown as EntityManager })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(RejectedMessageException);
        expect((error as RejectedMessageException).reasonCode).toBe('reserved_rma_prefix');
        expect(query).not.toHaveBeenCalled();
    });

    it('assigns the tracking code with next_tracking_code() when it inserts the dispatch', async () => {
        const query = vi
            .fn()
            .mockResolvedValueOnce([{ warehouse_id: 9 }])
            .mockResolvedValueOnce([{ dispatch_id: 44 }])
            .mockResolvedValue([]);

        await service.createFromRma(data, { manager: { query } as unknown as EntityManager });

        const insertDispatch = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dispatches'));
        expect(String(insertDispatch?.[0])).toMatch(/tracking_code[\s\S]*next_tracking_code\(\)/);
    });

    it('creates the dispatch in pickup_scheduled with its packages when the address has coordinates', async () => {
        const query = vi
            .fn()
            .mockResolvedValueOnce([{ warehouse_id: 9 }]) // warehouse lookup
            .mockResolvedValueOnce([{ dispatch_id: 42 }]) // dispatch insert
            .mockResolvedValue([]);

        const result = await service.createFromRma(data, { manager: { query } as unknown as EntityManager });

        expect(result).toEqual({ dispatchId: 42, status: 'pickup_scheduled' });
        const insertDispatch = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dispatches'));
        expect(insertDispatch?.[1]).toEqual(
            expect.arrayContaining(['pickup_scheduled', 'RMA-1', 'Av. Siempre Viva 123', -17.78, -63.18, 'Cliente Uno', '77712345', 'Producto defectuoso', 9, 1]),
        );
        const insertPackage = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dispatch_packages'));
        expect(insertPackage?.[1]).toEqual([42, 'PKG-1', 30, 20, 15, 4.5]);
        const insertEvent = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dispatch_events'));
        expect(String(insertEvent?.[0])).toContain('created_from_rma');
        expect(JSON.parse(insertEvent?.[1][1] as string)).toMatchObject({ rmaId: 'RMA-1', recordVersion: 1 });
    });

    it('creates the dispatch in address_review when the pickup address has no coordinates', async () => {
        const query = vi
            .fn()
            .mockResolvedValueOnce([{ warehouse_id: 9 }])
            .mockResolvedValueOnce([{ dispatch_id: 43 }])
            .mockResolvedValue([]);
        const withoutCoordinates: RmaPickupRequestedData = { ...data, pickupAddress: { line: data.pickupAddress.line } };

        const result = await service.createFromRma(withoutCoordinates, { manager: { query } as unknown as EntityManager });

        expect(result).toEqual({ dispatchId: 43, status: 'address_review' });
        const insertDispatch = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dispatches'));
        expect(insertDispatch?.[1]).toEqual(expect.arrayContaining(['address_review']));
    });
});
