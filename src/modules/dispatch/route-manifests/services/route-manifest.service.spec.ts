import { describe, expect, it, vi } from 'vitest';
import { RouteManifestService, type RecordManifestInput } from './route-manifest.service.js';

interface Setup {
    batch?: { version: number; vehicle_id: number | null; driver_id: number | null } | null;
    stops?: { dispatch_id: number; dispatch_type_id: number; sequence_order: number | null }[];
    cotejo?: { dispatch_id: number; event_type: string }[];
    nextVersion?: number;
}

function build(setup: Setup = {}) {
    const batch = setup.batch === undefined ? { version: 5, vehicle_id: 2, driver_id: 4 } : setup.batch;
    const stops = setup.stops ?? [
        { dispatch_id: 10, dispatch_type_id: 1, sequence_order: 1 },
        { dispatch_id: 20, dispatch_type_id: 1, sequence_order: 2 },
    ];
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM route_batches')) return batch ? [batch] : [];
        if (sql.includes('FROM dispatches WHERE route_batch_id')) return stops;
        if (sql.includes('FROM dispatch_events e')) return setup.cotejo ?? [];
        if (sql.includes('MAX(manifest_version)')) return [{ next: setup.nextVersion ?? 1 }];
        if (sql.includes('INSERT INTO route_manifests')) return [{ route_manifest_id: 77 }];
        return [];
    });
    const manager = { query } as never;
    const calls = (fragment: string) => query.mock.calls.filter(([sql]) => sql.includes(fragment));
    return { service: new RouteManifestService(), manager, query, calls };
}

const input = (over: Partial<RecordManifestInput> = {}): RecordManifestInput => ({ routeBatchId: 50, kind: 'confirmed', actorUserId: 9, ...over });

describe('RouteManifestService.record', () => {
    it('freezes a confirmed manifest with the route version, vehicle, driver and every stop planned', async () => {
        const { service, manager, calls } = build();

        const result = await service.record(manager, input());

        expect(result).toMatchObject({ routeManifestId: 77, manifestVersion: 1, routeVersion: 5 });
        expect(result.stops.map((stop) => [stop.dispatchId, stop.stopState])).toEqual([[10, 'planned'], [20, 'planned']]);
        expect(calls('INSERT INTO route_manifests')[0][1]).toEqual([50, 1, 'confirmed', 5, 2, 4, 9, null]);
        const saved = JSON.parse((calls('INSERT INTO route_manifest_stops')[0][1] as unknown[])[1] as string);
        expect(saved).toHaveLength(2);
        expect((calls('INSERT INTO route_manifest_stops')[0][1] as unknown[])[0]).toBe(77);
    });

    it('does not look for package-check failures in a confirmed manifest', async () => {
        const { service, manager, calls } = build();

        await service.record(manager, input());

        expect(calls('FROM dispatch_events e')).toHaveLength(0);
    });

    it('uses the exclusions the start already computed, without asking again', async () => {
        const { service, manager, calls } = build();

        const result = await service.record(manager, input({ kind: 'started', excludedDispatchIds: [20] }));

        expect(result.stops.map((stop) => [stop.dispatchId, stop.stopState, stop.exclusionCode])).toEqual([
            [10, 'departing', null],
            [20, 'excluded', 'cotejo_failed'],
        ]);
        expect(calls('FROM dispatch_events e')).toHaveLength(0);
    });

    it('reads the failed package checks of the batch for a revision that does not bring them', async () => {
        const { service, manager, calls } = build({ cotejo: [{ dispatch_id: 10, event_type: 'cotejo_failed' }, { dispatch_id: 20, event_type: 'cotejo_resolved' }] });

        const result = await service.record(manager, input({ kind: 'revised', reason: 'DRIVER-BREAKDOWN' }));

        expect(result.stops.map((stop) => [stop.dispatchId, stop.stopState])).toEqual([[10, 'excluded'], [20, 'departing']]);
        expect(calls('FROM dispatch_events e')[0][1]).toEqual([[10, 20], 50]);
    });

    it('takes the next version of the batch and keeps the reason of a revision', async () => {
        const { service, manager, calls } = build({ nextVersion: 3 });

        const result = await service.record(manager, input({ kind: 'revised', reason: '  DRIVER-BREAKDOWN ', actorUserId: null }));

        expect(result.manifestVersion).toBe(3);
        expect(calls('INSERT INTO route_manifests')[0][1]).toEqual([50, 3, 'revised', 5, 2, 4, null, 'DRIVER-BREAKDOWN']);
    });

    it('writes a manifest with no stops when the route is left empty, without a stops insert', async () => {
        const { service, manager, calls } = build({ stops: [] });

        const result = await service.record(manager, input({ kind: 'revised', reason: 'x' }));

        expect(result.stops).toEqual([]);
        expect(calls('INSERT INTO route_manifest_stops')).toHaveLength(0);
        expect(calls('FROM dispatch_events e')).toHaveLength(0);
    });

    it('refuses a revision without a reason before writing anything', async () => {
        const { service, manager, calls } = build();

        await expect(service.record(manager, input({ kind: 'revised', reason: '   ' }))).rejects.toThrow('needs a reason');
        await expect(service.record(manager, input({ kind: 'revised' }))).rejects.toThrow('needs a reason');
        expect(calls('INSERT INTO route_manifests')).toHaveLength(0);
    });

    it('fails when the batch does not exist', async () => {
        const { service, manager, calls } = build({ batch: null });

        await expect(service.record(manager, input())).rejects.toThrow('Route batch 50 does not exist');
        expect(calls('INSERT INTO route_manifests')).toHaveLength(0);
    });

    it('lets a database error out, so the transaction of the caller rolls back', async () => {
        const { service, manager, query } = build();
        query.mockImplementation(async (sql: string) => {
            if (sql.includes('INSERT INTO route_manifests')) throw new Error('duplicate key value violates unique constraint "uq_route_manifests_started"');
            if (sql.includes('FROM route_batches')) return [{ version: 5, vehicle_id: 2, driver_id: 4 }];
            if (sql.includes('FROM dispatches WHERE route_batch_id')) return [];
            if (sql.includes('MAX(manifest_version)')) return [{ next: 1 }];
            return [];
        });

        await expect(service.record(manager, input({ kind: 'started', excludedDispatchIds: [] }))).rejects.toThrow('uq_route_manifests_started');
    });
});
