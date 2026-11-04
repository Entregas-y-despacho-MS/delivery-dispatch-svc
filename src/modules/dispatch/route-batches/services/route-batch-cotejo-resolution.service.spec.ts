// ST-241.3 — RouteBatchCotejoResolutionService.resolve: escribe cotejo_resolved solo sobre una falla vigente. Todo mockeado.
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchCotejoResolutionService } from './route-batch-cotejo-resolution.service.js';

interface State {
  dispatch?: { route_batch_id: number | null; status: string };
  batchStatus?: string;
  latest?: 'cotejo_failed' | 'cotejo_resolved' | null;
  // What the dispatch looks like after the locks, when it changed while waiting for them.
  lockedDispatch?: { route_batch_id: number | null; status: string };
}

function build(state: State = {}) {
  const dispatch = 'dispatch' in state ? state.dispatch : { route_batch_id: 42, status: 'assigned' };
  const calls: Array<[string, unknown[]]> = [];
  const manager = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push([sql, params]);
      if (sql.includes('SELECT route_batch_id FROM dispatches')) return dispatch ? [{ route_batch_id: dispatch.route_batch_id }] : [];
      if (sql.includes('FROM route_batches')) return [{ status: state.batchStatus ?? 'in_execution' }];
      if (sql.includes('JOIN dispatch_statuses')) return [state.lockedDispatch ?? dispatch];
      if (sql.includes('SELECT e.event_type')) return state.latest === null ? [] : [{ event_type: state.latest ?? 'cotejo_failed' }];
      if (sql.includes('INSERT INTO dispatch_events')) return [{ created_at: new Date('2026-10-20T09:15:00Z') }];
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  const dataSource = { transaction: vi.fn(async (work: (m: unknown) => unknown) => await work(manager)) };
  return { service: new RouteBatchCotejoResolutionService(dataSource as any), calls };
}

describe('RouteBatchCotejoResolutionService.resolve', () => {
  it('records cotejo_resolved with the batch, the actor and the note, and answers with the moment', async () => {
    const { service, calls } = build();

    const result = await service.resolve(7, { note: '  Found in the warehouse ' }, 9);

    expect(result).toEqual({ dispatchId: 7, routeBatchId: 42, resolvedAt: '2026-10-20T09:15:00.000Z' });
    const insert = calls.find(([sql]) => sql.includes('INSERT INTO dispatch_events'))!;
    expect(insert[1].slice(0, 4)).toEqual([7, 'cotejo_resolved', 9, 'Found in the warehouse']);
    expect(JSON.parse(insert[1][4] as string)).toEqual({ routeBatchId: 42, resolvedBy: 9, note: 'Found in the warehouse' });
  });

  it('does not touch the status of the dispatch or of the batch', async () => {
    const { service, calls } = build();

    await service.resolve(7, {}, 9);

    expect(calls.some(([sql]) => /^\s*UPDATE\s/i.test(sql))).toBe(false);
  });

  it('works without a note and leaves a default reason', async () => {
    const { service, calls } = build();

    await service.resolve(7, {}, 9);

    const insert = calls.find(([sql]) => sql.includes('INSERT INTO dispatch_events'))!;
    expect(insert[1][3]).toBe('Package check failure resolved by the coordinator');
    expect(JSON.parse(insert[1][4] as string).note).toBeNull();
  });

  it('takes the batch lock before the dispatch lock, as start and accept do', async () => {
    const { service, calls } = build();

    await service.resolve(7, {}, 9);

    const order = calls.map(([sql]) => sql);
    const batchLock = order.findIndex((sql) => sql.includes('FROM route_batches') && sql.includes('FOR UPDATE'));
    const dispatchLock = order.findIndex((sql) => sql.includes('FOR UPDATE OF d'));
    expect(batchLock).toBeGreaterThan(-1);
    expect(batchLock).toBeLessThan(dispatchLock);
  });

  it('is 404 when the dispatch does not exist', async () => {
    const { service } = build({ dispatch: undefined });

    await expect(service.resolve(7, {}, 9)).rejects.toMatchObject({ response: { error: 'DISPATCH_NOT_FOUND' } });
  });

  it.each([
    ['without a route batch', { dispatch: { route_batch_id: null, status: 'assigned' } }, 'COTEJO_EXCLUSION_NOT_PENDING'],
    ['whose batch is not in execution', { batchStatus: 'confirmed' }, 'ROUTE_BATCH_NOT_IN_EXECUTION'],
    ['that is no longer assigned', { dispatch: { route_batch_id: 42, status: 'rescheduled' }, lockedDispatch: { route_batch_id: 42, status: 'rescheduled' } }, 'COTEJO_DISPATCH_NOT_ASSIGNED'],
    ['that left the batch while waiting for the locks', { lockedDispatch: { route_batch_id: null, status: 'assigned' } }, 'COTEJO_EXCLUSION_NOT_PENDING'],
    ['without any cotejo event', { latest: null }, 'COTEJO_EXCLUSION_NOT_PENDING'],
    ['already resolved', { latest: 'cotejo_resolved' as const }, 'COTEJO_EXCLUSION_NOT_PENDING'],
  ])('is 409 %s and writes nothing', async (_name, state, code) => {
    const { service, calls } = build(state as State);

    await expect(service.resolve(7, {}, 9)).rejects.toMatchObject({ response: { error: code } });
    expect(calls.some(([sql]) => sql.includes('INSERT INTO dispatch_events'))).toBe(false);
  });
});
