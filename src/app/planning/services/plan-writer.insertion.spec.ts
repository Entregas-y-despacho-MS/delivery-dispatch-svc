import { describe, expect, it, vi } from 'vitest';
import type { InsertedStop, ProposedInsertion } from '../domain/plan-types.js';
import { PlanWriterService } from './plan-writer.service.js';

const WINDOW_9 = new Date('2026-10-14T13:00:00.000Z');
const WINDOW_11 = new Date('2026-10-14T15:00:00.000Z');

const stop = (over: Partial<InsertedStop> & { dispatchId: number; sequence: number }): InsertedStop => ({
    windowStart: null, windowEnd: null, previousSequence: null, isNew: false, ...over,
});

/** Batch 500 had 101 (notified), 102 and 103; order 1 is inserted between 101 and 102. */
const insertion = (over: Partial<ProposedInsertion> = {}): ProposedInsertion => ({
    routeBatchId: 500,
    expectedVersion: 3,
    shiftDate: '2026-10-14',
    zoneId: 1,
    zoneCode: 'ZON-SUR',
    zoneName: 'Achumani',
    vehicleId: 7,
    stops: [
        stop({ dispatchId: 101, sequence: 1, previousSequence: 1 }),
        stop({ dispatchId: 1, sequence: 2, isNew: true, windowStart: WINDOW_9, windowEnd: WINDOW_11 }),
        stop({ dispatchId: 102, sequence: 3, previousSequence: 2, windowStart: WINDOW_9, windowEnd: WINDOW_11 }),
        stop({ dispatchId: 103, sequence: 4, previousSequence: 3, windowStart: WINDOW_9, windowEnd: WINDOW_11 }),
    ],
    insertedDispatchIds: [1],
    ...over,
});

const currentStops = [
    { dispatch_id: 101, sequence_order: 1, window_start: WINDOW_9 },
    { dispatch_id: 102, sequence_order: 2, window_start: WINDOW_9 },
    { dispatch_id: 103, sequence_order: 3, window_start: null },
];

function build(options: {
    batch?: { status: string; version: number } | null;
    current?: typeof currentStops;
    locked?: { dispatch_id: number; status: string; route_batch_id: number | null; reserved: boolean }[];
}) {
    const saved: Record<string, any[]> = { DispatchEvent: [], RouteBatchEvent: [] };
    const manager: any = {
        query: vi.fn()
            .mockResolvedValueOnce(options.batch === null ? [] : [options.batch ?? { status: 'provisional', version: 3 }])
            .mockResolvedValueOnce(options.current ?? currentStops)
            .mockResolvedValueOnce(options.locked ?? [{ dispatch_id: 1, status: 'pending', route_batch_id: null, reserved: false }])
            .mockResolvedValue([]),
        getRepository: vi.fn((entity: { name: string }) => ({
            create: (data: unknown) => data,
            save: vi.fn(async (data: unknown) => {
                saved[entity.name]?.push(...(Array.isArray(data) ? data : [data]));
                return data;
            }),
        })),
    };
    const dataSource: any = { transaction: vi.fn(async (callback: (m: unknown) => unknown) => await callback(manager)) };
    const reviewer = { assignReviewer: vi.fn() };
    return { service: new PlanWriterService(dataSource, reviewer as any), manager, saved, reviewer };
}

const context = { trigger: 'scheduled' as const, occurrence: 'plan-generation@2026-10-13T13:30' };
const sqlOf = (manager: any) => manager.query.mock.calls.map(([sql]: [string]) => sql as string);

describe('PlanWriterService.writeInsertion', () => {
    it('locks the batch, renumbers in two steps and bumps the batch version', async () => {
        const { service, manager } = build({});

        const result = await service.writeInsertion(insertion(), context);

        expect(result).toEqual({ routeBatchId: 500, applied: true, stale: false, insertedDispatchIds: [1], skippedDispatchIds: [] });
        const sql = sqlOf(manager);
        expect(sql[0]).toContain('FROM route_batches');
        expect(sql[0]).toContain('FOR UPDATE');

        const park = sql.findIndex((text) => text.includes('SET sequence_order = -sequence_order'));
        const renumber = sql.findIndex((text) => text.includes('sequence_order = v.seq') && text.includes('CASE WHEN v.bump'));
        const place = sql.findIndex((text) => text.includes('route_batch_id = $1,') && text.includes('sequence_order = v.seq'));
        const version = sql.findIndex((text) => text.includes('UPDATE route_batches SET version = version + 1'));
        // Park every sequence on its negative first (D-32), then number, then the batch version.
        expect(park).toBeGreaterThan(0);
        expect(renumber).toBeGreaterThan(park);
        expect(place).toBeGreaterThan(renumber);
        expect(version).toBeGreaterThan(place);
    });

    it('numbers the existing stops without touching the window of a notified one, and bumps only what moved', async () => {
        const { service, manager } = build({});

        await service.writeInsertion(insertion(), context);

        const renumber = manager.query.mock.calls.find(([sql]: [string]) => sql.includes('CASE WHEN v.bump'));
        const [ids, sequences, starts, ends, bump] = renumber[1];
        expect(ids).toEqual([101, 102, 103]);
        expect(sequences).toEqual([1, 3, 4]);
        expect(starts).toEqual([null, WINDOW_9, WINDOW_9]);
        expect(ends).toEqual([null, WINDOW_11, WINDOW_11]);
        // 101 stays in place with its window untouched; 102 and 103 moved.
        expect(bump).toEqual([false, true, true]);
    });

    it('moves the new order to in_planning with its sequence and proposed window', async () => {
        const { service, manager } = build({});

        await service.writeInsertion(insertion(), context);

        const place = manager.query.mock.calls.find(([sql]: [string]) => sql.includes('route_batch_id = $1,'));
        expect(place[1]).toEqual([500, [1], [2], [WINDOW_9], [WINDOW_11], 'in_planning']);
    });

    it('records order_added with the position and the stops it shifted, and a status event', async () => {
        const { service, saved } = build({});

        await service.writeInsertion(insertion(), context);

        expect(saved.RouteBatchEvent).toEqual([
            expect.objectContaining({
                routeBatchId: 500, dispatchId: 1, eventType: 'order_added', actorType: 'system',
                metadata: expect.objectContaining({
                    dispatchId: 1, position: 2, previousSequence: null, newSequence: 2,
                    shiftedDispatchIds: [102, 103], zoneCode: 'ZON-SUR', batchVersion: 4,
                }),
            }),
        ]);
        expect(saved.DispatchEvent).toEqual([
            expect.objectContaining({
                dispatchId: 1, eventType: 'status_changed',
                metadata: expect.objectContaining({ from: 'pending', to: 'in_planning', routeBatchId: 500, sequenceOrder: 2 }),
            }),
        ]);
    });

    it('does not change the reviewer of an open batch (the same coordinator reviews the addition)', async () => {
        const { service, reviewer } = build({});

        await service.writeInsertion(insertion(), context);

        expect(reviewer.assignReviewer).not.toHaveBeenCalled();
    });

    it('writes nothing when the version of the batch moved after the plan', async () => {
        const { service, manager } = build({ batch: { status: 'provisional', version: 4 } });

        const result = await service.writeInsertion(insertion(), context);

        expect(result).toMatchObject({ applied: false, stale: true, insertedDispatchIds: [], skippedDispatchIds: [1] });
        expect(manager.query).toHaveBeenCalledOnce();
    });

    it('writes nothing when the batch is no longer provisional', async () => {
        const { service, manager } = build({ batch: { status: 'pending_final_review', version: 3 } });

        const result = await service.writeInsertion(insertion(), context);

        expect(result.stale).toBe(true);
        expect(manager.query).toHaveBeenCalledOnce();
    });

    it('writes nothing when the stops of the batch are not the ones the plan saw', async () => {
        const { service, manager } = build({ current: currentStops.slice(0, 2) });

        const result = await service.writeInsertion(insertion(), context);

        expect(result).toMatchObject({ applied: false, stale: true });
        expect(sqlOf(manager).some((text) => text.includes('-sequence_order'))).toBe(false);
    });

    it('leaves out an order that changed meanwhile and writes nothing if it was the only one', async () => {
        const { service, manager } = build({
            locked: [{ dispatch_id: 1, status: 'cancelled', route_batch_id: null, reserved: false }],
        });

        const result = await service.writeInsertion(insertion(), context);

        expect(result).toEqual({ routeBatchId: 500, applied: false, stale: false, insertedDispatchIds: [], skippedDispatchIds: [1] });
        expect(sqlOf(manager).some((text) => text.includes('-sequence_order'))).toBe(false);
    });

    it('leaves out an order a coordinator is editing', async () => {
        const { service } = build({
            locked: [{ dispatch_id: 1, status: 'pending', route_batch_id: null, reserved: true }],
        });

        const result = await service.writeInsertion(insertion(), context);

        expect(result.applied).toBe(false);
        expect(result.skippedDispatchIds).toEqual([1]);
    });
});
