import { describe, expect, it, vi } from 'vitest';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../dispatch-status/dispatch-status-changed.event.js';
import type { CreatePickupOrderDto } from './dto/create-pickup-order.dto.js';
import { InvalidPickupDateRangeException, PickupDateInPastException, PickupOrderNotFoundException } from './exceptions/index.js';
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
    preferred_pickup_date: '2026-11-06', warehouse_id: 3, warehouse_code: 'WH-LPZ-01', warehouse_name: 'Central', created_at: NOW, receipt_result: null,
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

describe('PickupOrdersService.findAll', () => {
    function buildList(rows: unknown[] = [row], total = 1) {
        const query = vi.fn().mockResolvedValueOnce([{ total }]).mockResolvedValueOnce(rows);
        const dataSource = { manager: { query }, query };
        const service = new PickupOrdersService(dataSource as never, {} as never, {} as never);
        return { service, query };
    }

    it('without filters it lists every status and origin, newest first, with the pagination meta', async () => {
        const { service, query } = buildList([row], 25);

        const result = await service.findAll({ page: 2, limit: 10 });

        expect(result).toMatchObject({ data: [{ id: 55, origin: 'manual' }], meta: { page: 2, limit: 10, total: 25, pages: 3 } });
        const [countSql] = query.mock.calls[0];
        const [listSql, listArgs] = query.mock.calls[1];
        expect(String(countSql)).toContain('COUNT(*)');
        expect(String(listSql)).toContain('ORDER BY d.dispatch_id DESC');
        expect(String(listSql)).not.toContain('ds.name =');
        expect(listArgs).toEqual([10, 10]);
    });

    it('binds status and Bolivia-day range as parameters, never into the SQL text', async () => {
        const { service, query } = buildList();

        await service.findAll({ page: 1, limit: 10, status: 'cancelled' as never, from: '2026-11-01', to: '2026-11-30' });

        const [listSql, listArgs] = query.mock.calls[1];
        expect(String(listSql)).toContain('ds.name = $1');
        expect(String(listSql)).toContain("(d.preferred_pickup_date AT TIME ZONE 'America/La_Paz')::date >= $2::date");
        expect(String(listSql)).toContain("(d.preferred_pickup_date AT TIME ZONE 'America/La_Paz')::date <= $3::date");
        expect(String(listSql)).not.toContain('cancelled');
        expect(listArgs).toEqual(['cancelled', '2026-11-01', '2026-11-30', 10, 0]);
        // the count carries the same filters but not the page
        expect(query.mock.calls[0][1]).toEqual(['cancelled', '2026-11-01', '2026-11-30']);
    });

    it.each([
        ['manual', "LIKE 'MANUAL-%'", 'NOT LIKE'],
        ['rma', "NOT LIKE 'MANUAL-%'", null],
    ] as const)('origin %s filters by the reserved MANUAL- prefix', async (origin, expected, absent) => {
        const { service, query } = buildList();

        await service.findAll({ page: 1, limit: 10, origin });

        const where = String(query.mock.calls[1][0]).split('WHERE dt.name')[1] as string;
        expect(where).toContain(expected);
        if (absent) expect(where).not.toContain(absent);
    });

    it('rejects a range whose end is before its start without querying', async () => {
        const { service, query } = buildList();

        await expect(service.findAll({ page: 1, limit: 10, from: '2026-11-10', to: '2026-11-09' })).rejects.toBeInstanceOf(InvalidPickupDateRangeException);

        expect(query).not.toHaveBeenCalled();
    });

    it('an empty result has zero pages', async () => {
        const { service } = buildList([], 0);

        await expect(service.findAll({ page: 1, limit: 10 })).resolves.toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } });
    });
});

describe('PickupOrdersService.findOne', () => {
    it('answers PICKUP_ORDER_NOT_FOUND for an id that is not a pickup order', async () => {
        const { service } = build({ findRows: [] });

        await expect(service.findOne(99)).rejects.toBeInstanceOf(PickupOrderNotFoundException);
    });
});

describe('toPickupOrderDto receiptResult', () => {
    it.each(['complete', 'with_differences', 'rejected'] as const)('passes a %s receipt through', (result) => {
        expect(toPickupOrderDto({ ...row, receipt_result: result }).receiptResult).toBe(result);
    });

    it('is null when the order has no receipt', () => {
        expect(toPickupOrderDto({ ...row, receipt_result: null }).receiptResult).toBeNull();
    });
});

describe('toPickupOrderDto', () => {
    it('keeps the nulls of an RMA without coordinates, warehouse or description', () => {
        const dtoOut = toPickupOrderDto({ ...row, origin: 'rma', source_order_ref: 'RMA-1', latitude: null, longitude: null, package_contents: null, warehouse_id: null, warehouse_code: null, warehouse_name: null, preferred_pickup_date: null });

        expect(dtoOut).toMatchObject({ origin: 'rma', latitude: null, longitude: null, packageContents: null, destinationWarehouse: null, preferredPickupDate: null });
    });
});
