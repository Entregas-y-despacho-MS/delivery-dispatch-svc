import { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchAcceptService } from './route-batch-accept.service.js';

const eventId = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a11';
const photoId = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10';
const failure = {
  dispatchId: 21,
  packageIds: ['PKG-21'],
  reason: 'damaged' as const,
  detail: 'Crushed',
  photoId,
};

interface Options {
  batch?: {
    status: string;
    driver_id: number | null;
    accepted_at: Date | null;
  }[];
  prior?: { route_batch_id: number; metadata: Record<string, unknown> }[];
  dispatches?: { dispatch_id: number; status: string }[];
  packages?: { dispatch_id: number; external_package_id: string }[];
  photos?: { photo_id: string; photo_url: string }[];
  updated?: number;
}

function setup(options: Options = {}) {
  const writes: { sql: string; params: unknown[] }[] = [];
  const manager = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM route_batches'))
        return (
          options.batch ?? [
            { status: 'confirmed', driver_id: 7, accepted_at: null },
          ]
        );
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes("metadata->>'eventId'")) return options.prior ?? [];
      if (sql.includes('FROM dispatches'))
        return options.dispatches ?? [{ dispatch_id: 21, status: 'assigned' }];
      if (sql.includes('FROM dispatch_packages'))
        return (
          options.packages ?? [
            { dispatch_id: 21, external_package_id: 'PKG-21' },
          ]
        );
      if (sql.includes("metadata->>'photoId'"))
        return (
          options.photos ?? [{ photo_id: photoId, photo_url: 'local://p.jpg' }]
        );
      if (sql.startsWith('UPDATE route_batches')) {
        writes.push({ sql, params });
        const rows = Array(options.updated ?? 1).fill({ route_batch_id: 5 });
        return [rows, rows.length];
      }
      if (sql.includes('INSERT INTO')) {
        writes.push({ sql, params });
        return [];
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  const dataSource = {
    transaction: vi.fn(async (work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  } as unknown as DataSource;
  return { service: new RouteBatchAcceptService(dataSource), writes };
}

describe('RouteBatchAcceptService', () => {
  it('accepts a batch with a conforming check and records the batch event', async () => {
    const { service, writes } = setup();
    const result = await service.accept(5, { eventId }, 7);
    expect(result.failedDispatchIds).toEqual([]);
    expect(result.routeBatchId).toBe(5);
    expect(writes.map(({ sql }) => sql.split(/\s/)[0])).toEqual([
      'UPDATE',
      'INSERT',
    ]);
    expect(writes[1].params[1]).toBe('batch_accepted');
  });

  it('records one cotejo_failed event per failure with reason, photo and actor', async () => {
    const { service, writes } = setup();
    const result = await service.accept(5, { eventId, failures: [failure] }, 7);
    expect(result.failedDispatchIds).toEqual([21]);
    const insert = writes.find(
      ({ sql, params }) =>
        sql.includes('INSERT INTO dispatch_events') &&
        params[1] === 'cotejo_failed',
    )!;
    expect(insert.params.slice(0, 4)).toEqual([21, 'cotejo_failed', 7, 'damaged']);
    expect(JSON.parse(insert.params[4] as string)).toMatchObject({
      routeBatchId: 5,
      packageIds: ['PKG-21'],
      photo: 'local://p.jpg',
      photoId,
    });
  });

  it('returns the original result for a retry of the same eventId without writing', async () => {
    const { service, writes } = setup({
      prior: [
        {
          route_batch_id: 5,
          metadata: {
            acceptedAt: '2026-10-20T07:50:00.000Z',
            failedDispatchIds: [21],
          },
        },
      ],
    });
    const result = await service.accept(5, { eventId }, 7);
    expect(result).toEqual({
      routeBatchId: 5,
      acceptedAt: '2026-10-20T07:50:00.000Z',
      failedDispatchIds: [21],
    });
    expect(writes).toHaveLength(0);
  });

  it('rejects an eventId already used by another batch', async () => {
    const { service } = setup({
      prior: [{ route_batch_id: 9, metadata: {} }],
    });
    await expect(service.accept(5, { eventId }, 7)).rejects.toMatchObject({
      response: { error: 'ROUTE_ACCEPT_EVENT_ID_ALREADY_USED' },
    });
  });

  it('rejects a missing batch with 404 and another driver with 403', async () => {
    await expect(
      setup({ batch: [] }).service.accept(5, { eventId }, 7),
    ).rejects.toMatchObject({ response: { error: 'ROUTE_BATCH_NOT_FOUND' } });
    const other = setup({
      batch: [{ status: 'confirmed', driver_id: 8, accepted_at: null }],
    });
    await expect(other.service.accept(5, { eventId }, 7)).rejects.toMatchObject(
      { status: 403 },
    );
    expect(other.writes).toHaveLength(0);
  });

  it('rejects a batch that is not confirmed and one already accepted with 409', async () => {
    await expect(
      setup({
        batch: [
          { status: 'pending_final_review', driver_id: 7, accepted_at: null },
        ],
      }).service.accept(5, { eventId }, 7),
    ).rejects.toMatchObject({ response: { error: 'ROUTE_BATCH_NOT_CONFIRMED' } });
    await expect(
      setup({
        batch: [{ status: 'confirmed', driver_id: 7, accepted_at: new Date() }],
      }).service.accept(5, { eventId }, 7),
    ).rejects.toMatchObject({
      response: { error: 'ROUTE_BATCH_ALREADY_ACCEPTED' },
    });
  });

  it('rejects failures that do not match the batch with 400', async () => {
    const send = (options: Options, failures = [failure]) =>
      setup(options).service.accept(5, { eventId, failures }, 7);
    await expect(send({}, [failure, failure])).rejects.toMatchObject({
      response: { error: 'COTEJO_FAILURE_DUPLICATED_DISPATCH' },
    });
    await expect(send({ dispatches: [] })).rejects.toMatchObject({
      response: { error: 'COTEJO_FAILURE_DISPATCH_NOT_IN_BATCH' },
    });
    await expect(
      send({ dispatches: [{ dispatch_id: 21, status: 'cancelled' }] }),
    ).rejects.toMatchObject({
      response: { error: 'COTEJO_FAILURE_DISPATCH_NOT_ASSIGNED' },
    });
    await expect(send({ packages: [] })).rejects.toMatchObject({
      response: { error: 'COTEJO_FAILURE_PACKAGE_NOT_IN_DISPATCH' },
    });
    await expect(send({ photos: [] })).rejects.toMatchObject({
      response: { error: 'COTEJO_PHOTO_NOT_FOUND' },
    });
  });

  it('writes nothing when the batch changed before the update', async () => {
    const { service, writes } = setup({ updated: 0 });
    await expect(service.accept(5, { eventId }, 7)).rejects.toMatchObject({
      response: { error: 'ROUTE_BATCH_ALREADY_ACCEPTED' },
    });
    expect(writes.filter(({ sql }) => sql.startsWith('INSERT'))).toHaveLength(0);
  });
});
