import { describe, expect, it, vi } from 'vitest';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../dispatch-status/dispatch-status-changed.event.js';
import type { CreatePickupOrderDto } from './dto/create-pickup-order.dto.js';
import { PickupDateInPastException, PickupOrderNotFoundException } from './exceptions/index.js';
import { PickupOrdersService, toPickupOrderDto } from './pickup-orders.service.js';

// 2026-11-06 22:00 in Bolivia is already 2026-11-07 02:00 UTC: "today" must be the Bolivia day.
const NOW = new Date('2026-11-07T02:00:00.000Z');

const dto: CreatePickupOrderDto = {
    warehouseCode: 'WH-LPZ-01',
    contactName: 'María',
    contactPhone: '+59171234567',
    address: 'Calle 21 de Calacoto 8790',
    latitude: -16.54,
    longitude: -68.08,
    preferredPickupDate: '2026-11-06',
    packageContents: '1 notebook',
    returnReason: 'Falla de encendido',
};

const row = {
    id: 55, tracking_code: 'DSP-2026-00042', source_order_ref: 'MANUAL-DSP-2026-00042', origin: 'manual' as const, status: 'pickup_scheduled',
    contact_name: 'María', contact_phone: '+59171234567', contact_email: null, address: 'Calle 21', reference: null,
    latitude: '-16.540000', longitude: '-68.080000', return_reason: 'Falla', package_contents: '1 notebook', estimated_boxes: null,
    preferred_pickup_date: '2026-11-06', warehouse_id: 3, warehouse_code: 'WH-LPZ-01', warehouse_name: 'Central', created_at: NOW,
};

function build(overrides: { findRows?: unknown[]; emit?: () => void } = {}) {
    const manager = { query: vi.fn().mockResolvedValue(overrides.findRows ?? [row]) };
    const dataSource = { manager, transaction: vi.fn(async (work: (m: unknown) => unknown) => await work(manager)) };
    const pickups = { createManual: vi.fn().mockResolvedValue({ dispatchId: 55, status: 'pickup_scheduled', trackingCode: 'DSP-2026-00042', sourceOrderRef: 'MANUAL-DSP-2026-00042' }) };
    const events = { emit: vi.fn(overrides.emit ?? (() => undefined)) };
    const service = new PickupOrdersService(dataSource as never, pickups as never, events as never);
    return { service, dataSource, pickups, events, manager };
}

describe('PickupOrdersService.create', () => {
    it('accepts today in Bolivia even when UTC is already tomorrow, creates in one transaction and announces to the web', async () => {
        const { service, dataSource, pickups, events } = build();

        const result = await service.create(dto, 7, NOW);

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(pickups.createManual).toHaveBeenCalledWith(dto, 7, { manager: expect.anything() });
        expect(events.emit).toHaveBeenCalledWith(DISPATCH_STATUS_CHANGED_EVENT, expect.objectContaining({ dispatchId: 55, status: 'pickup_scheduled', previousStatus: 'pickup_scheduled', version: 0 }));
        expect(result).toMatchObject({ id: 55, origin: 'manual', status: 'pickup_scheduled', latitude: -16.54, destinationWarehouse: { code: 'WH-LPZ-01' } });
    });

    it('rejects a preferred day before today (Bolivia) without opening a transaction', async () => {
        const { service, dataSource, pickups } = build();

        await expect(service.create({ ...dto, preferredPickupDate: '2026-11-05' }, 7, NOW)).rejects.toBeInstanceOf(PickupDateInPastException);

        expect(dataSource.transaction).not.toHaveBeenCalled();
        expect(pickups.createManual).not.toHaveBeenCalled();
    });

    it('a failing web listener does not turn a committed creation into an error', async () => {
        const { service } = build({ emit: () => { throw new Error('socket down'); } });

        await expect(service.create(dto, 7, NOW)).resolves.toMatchObject({ id: 55 });
    });

    it('does not announce anything when the creation fails', async () => {
        const { service, pickups, events } = build();
        pickups.createManual.mockRejectedValue(new Error('boom'));

        await expect(service.create(dto, 7, NOW)).rejects.toThrow('boom');

        expect(events.emit).not.toHaveBeenCalled();
    });
});

describe('PickupOrdersService.findOne', () => {
    it('answers PICKUP_ORDER_NOT_FOUND for an id that is not a pickup order', async () => {
        const { service } = build({ findRows: [] });

        await expect(service.findOne(99)).rejects.toBeInstanceOf(PickupOrderNotFoundException);
    });
});

describe('toPickupOrderDto', () => {
    it('keeps the nulls of an RMA without coordinates, warehouse or description', () => {
        const dtoOut = toPickupOrderDto({ ...row, origin: 'rma', source_order_ref: 'RMA-1', latitude: null, longitude: null, package_contents: null, warehouse_id: null, warehouse_code: null, warehouse_name: null, preferred_pickup_date: null });

        expect(dtoOut).toMatchObject({ origin: 'rma', latitude: null, longitude: null, packageContents: null, destinationWarehouse: null, preferredPickupDate: null });
    });
});
