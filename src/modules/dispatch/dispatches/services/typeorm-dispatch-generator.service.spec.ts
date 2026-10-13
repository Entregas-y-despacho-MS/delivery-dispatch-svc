import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { ConsolidatedOrder } from '../../../messaging/sales-order-intake/domain/consolidated-order.types.js';
import { TypeOrmDispatchGenerator } from './typeorm-dispatch-generator.service.js';

function consolidatedOrder(overrides: Partial<ConsolidatedOrder> = {}): ConsolidatedOrder {
    return {
        salesOrderId: 'SO-101',
        confirmedAt: '2026-10-12T14:00:00.000Z',
        recipient: { name: 'Ana Pérez', phone: '+59170000000', email: 'ana@example.com' },
        deliveryAddress: {
            line: 'Av. Arce 2345', reference: 'Edificio azul',
            location: { latitude: -16.5412, longitude: -68.0731 },
        },
        priority: 'urgent',
        warehouseId: 'WH-LPZ-01',
        packages: [
            { packageId: 'PK-1', lengthCm: 10, widthCm: 20, heightCm: 30, grossWeightKg: 2.5 },
            { packageId: 'PK-2', lengthCm: 15, widthCm: 25, heightCm: 35, grossWeightKg: 3.5 },
        ],
        handlingConditions: ['fragile'],
        evidencePolicy: 'contactless_delivery',
        physicallyPacked: true,
        ...overrides,
    };
}

function createManager(zoneId: number | null = 7) {
    let dispatchId = 40;
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM warehouses')) return [{ id: 3 }];
        if (sql.includes('FROM delivery_zones')) return zoneId === null ? [] : [{ id: zoneId }];
        if (sql.includes('FROM settings')) return [
            { setting_key: 'service_min_operating_days', setting_value: '2' },
            { setting_key: 'service_max_operating_days', setting_value: '3' },
            { setting_key: 'plan_working_days', setting_value: '1,2,3,4,5' },
            { setting_key: 'plan_non_working_dates', setting_value: '' },
        ];
        if (sql.includes('INSERT INTO dispatches')) return [{ id: dispatchId++ }];
        return [];
    });
    return { manager: { query } as unknown as EntityManager, query };
}

function statement(query: ReturnType<typeof vi.fn>, text: string) {
    const call = query.mock.calls.find(([sql]) => String(sql).includes(text));
    expect(call, `Missing SQL statement: ${text}`).toBeDefined();
    return call! as [string, unknown[]];
}

describe('TypeOrmDispatchGenerator', () => {
    it('creates a pending delivery with its zone, origin, contact, packages, D0 and service term in the caller transaction', async () => {
        const { manager, query } = createManager();
        const order = consolidatedOrder();

        expect(await new TypeOrmDispatchGenerator().createFromConsolidated(order, { manager })).toEqual({ dispatchId: 40 });

        const [zoneSql, zoneParams] = statement(query, 'FROM delivery_zones');
        expect(zoneSql).toContain('boundary @> point($1::float8, $2::float8)');
        expect(zoneParams).toEqual([-68.0731, -16.5412]);

        const [insertSql, params] = statement(query, 'INSERT INTO dispatches');
        expect(insertSql).toContain("WHERE name = 'delivery'");
        expect(insertSql).toContain('next_tracking_code()');
        expect(insertSql).not.toContain('scheduled_window_start');
        expect(insertSql).not.toContain('scheduled_window_end');
        expect(insertSql).not.toContain('tracking_token');
        expect(params).toEqual([
            'pending', 'SO-101', 'urgent', 'Av. Arce 2345', 'Edificio azul',
            -16.5412, -68.0731, 7, 'Ana Pérez', '+59170000000', 'ana@example.com',
            'contactless_delivery', expect.any(Date), new Date('2026-10-12T14:00:00.000Z'), 3,
        ]);

        const packageCalls = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO dispatch_packages'));
        expect(packageCalls).toHaveLength(2);
        expect(packageCalls[0][1]).toEqual([40, 'PK-1', 10, 20, 30, 2.5, ['fragile']]);
        expect(packageCalls[1][1]).toEqual([40, 'PK-2', 15, 25, 35, 3.5, ['fragile']]);

        const [, eventParams] = statement(query, 'INSERT INTO dispatch_events');
        expect(eventParams[0]).toBe(40);
        expect(JSON.parse(eventParams[1] as string)).toMatchObject({
            serviceTerm: { earliestDate: '2026-10-14', latestDate: '2026-10-15' },
            addressReview: false,
        });
        expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO audit_logs'))).toBe(false);
    });

    it.each([
        ['missing', undefined],
        ['outside coverage', { latitude: -16.5412, longitude: -68.0731 }],
        ['invalid', { latitude: 95, longitude: -68.0731 }],
    ])('creates address_review and records an alert when coordinates are %s', async (condition, location) => {
        const { manager, query } = createManager(null);
        const order = consolidatedOrder({ deliveryAddress: { line: 'Calle 1', ...(location && { location }) } });

        await new TypeOrmDispatchGenerator().createFromConsolidated(order, { manager });

        const [, params] = statement(query, 'INSERT INTO dispatches');
        expect(params[0]).toBe('address_review');
        expect(params[7]).toBeNull();
        if (condition !== 'outside coverage') {
            expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM delivery_zones'))).toBe(false);
        }
        const [, auditParams] = statement(query, 'INSERT INTO audit_logs');
        expect(JSON.parse(auditParams[0] as string)).toEqual({
            dispatchId: 40, salesOrderId: 'SO-101', reason: 'missing_or_uncovered_location',
        });
    });

    it('requests a fresh tracking code for each dispatch and lets the database enforce uniqueness', async () => {
        const { manager, query } = createManager();
        const generator = new TypeOrmDispatchGenerator();

        await generator.createFromConsolidated(consolidatedOrder(), { manager });
        await generator.createFromConsolidated(consolidatedOrder({ salesOrderId: 'SO-102' }), { manager });

        const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO dispatches'));
        expect(inserts).toHaveLength(2);
        expect(inserts.every(([sql]) => String(sql).includes('next_tracking_code()'))).toBe(true);
        expect(inserts[0][1][1]).toBe('SO-101');
        expect(inserts[1][1][1]).toBe('SO-102');
    });

    it('rejects a missing transaction manager or warehouse before inserting a dispatch', async () => {
        const generator = new TypeOrmDispatchGenerator();
        await expect(generator.createFromConsolidated(consolidatedOrder(), {})).rejects.toThrow('transaction manager');

        const { manager, query } = createManager();
        query.mockResolvedValueOnce([]);
        await expect(generator.createFromConsolidated(consolidatedOrder(), { manager })).rejects.toThrow('Unknown or inactive warehouse');
        expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO dispatches'))).toBe(false);
    });
});
