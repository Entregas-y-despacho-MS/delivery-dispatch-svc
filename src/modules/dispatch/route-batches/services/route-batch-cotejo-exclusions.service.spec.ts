// ST-241.3 — RouteBatchCotejoExclusionsService.findAll: paradas excluidas con motivo, bulto y foto firmada. Todo mockeado.
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchCotejoExclusionsService } from './route-batch-cotejo-exclusions.service.js';

const stop = (dispatchId: number, over: Record<string, unknown> = {}) => ({
  dispatchId,
  routeBatchId: 42,
  shiftDate: '2026-10-20',
  sequenceOrder: dispatchId,
  sourceOrderRef: `SO-${dispatchId}`,
  trackingCode: `TRK-${dispatchId}`,
  deliveryAddress: 'Av. Arce 2345',
  contactName: 'Maria',
  ...over,
});

const event = (
  dispatchId: number,
  eventType: 'cotejo_failed' | 'cotejo_resolved',
  at: string,
  over: Record<string, unknown> = {},
) => ({
  dispatchId,
  eventType,
  reason: eventType === 'cotejo_failed' ? 'damaged' : 'Package found',
  createdAt: new Date(at),
  metadata: { routeBatchId: 42, packageId: 'PKG-1', detail: null, photo: 'local://cotejo/a.jpg' },
  ...over,
});

function build(stops: unknown[], events: unknown[], getAccessUrl = vi.fn(async (url: string) => ({ url: `signed:${url}`, expiresAt: new Date() }))) {
  const query = vi.fn().mockResolvedValueOnce(stops).mockResolvedValueOnce(events);
  return { service: new RouteBatchCotejoExclusionsService({ query } as any, { getAccessUrl } as any), query, getAccessUrl };
}

describe('RouteBatchCotejoExclusionsService.findAll', () => {
  it('returns an empty list, without a second query, when no stop is excluded', async () => {
    const { service, query } = build([], []);

    await expect(service.findAll()).resolves.toEqual({ data: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('lists the stop with each failed package, its reason and a signed photo url (never the stored one)', async () => {
    const { service, getAccessUrl } = build(
      [stop(7)],
      [event(7, 'cotejo_failed', '2026-10-20T07:50:00Z', { metadata: { routeBatchId: 42, packageId: 'PKG-9', detail: 'Crushed', photo: 'local://cotejo/a.jpg' } })],
    );

    const { data } = await service.findAll();

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ dispatchId: 7, routeBatchId: 42, sourceOrderRef: 'SO-7', deliveryAddress: 'Av. Arce 2345' });
    expect(data[0].failures).toEqual([
      { packageId: 'PKG-9', reason: 'damaged', detail: 'Crushed', photoUrl: 'signed:local://cotejo/a.jpg', reportedAt: '2026-10-20T07:50:00.000Z' },
    ]);
    expect(getAccessUrl).toHaveBeenCalledWith('local://cotejo/a.jpg', 300);
  });

  it('keeps one failure per package of the same stop and signs a shared photo once', async () => {
    const { service, getAccessUrl } = build(
      [stop(7)],
      [
        event(7, 'cotejo_failed', '2026-10-20T07:50:00Z', { metadata: { routeBatchId: 42, packageId: 'PKG-1', photo: 'local://cotejo/a.jpg' } }),
        event(7, 'cotejo_failed', '2026-10-20T07:50:00Z', { reason: 'missing', metadata: { routeBatchId: 42, packageId: 'PKG-2', photo: 'local://cotejo/a.jpg' } }),
      ],
    );

    const { data } = await service.findAll();

    expect(data[0].failures.map(({ packageId, reason }) => [packageId, reason])).toEqual([['PKG-1', 'damaged'], ['PKG-2', 'missing']]);
    expect(getAccessUrl).toHaveBeenCalledTimes(1);
  });

  it('drops the failures that came before a resolution and keeps the ones after it', async () => {
    const { service } = build(
      [stop(7)],
      [
        event(7, 'cotejo_failed', '2026-10-20T07:00:00Z', { metadata: { routeBatchId: 42, packageId: 'OLD', photo: 'local://cotejo/old.jpg' } }),
        event(7, 'cotejo_resolved', '2026-10-20T07:30:00Z'),
        event(7, 'cotejo_failed', '2026-10-20T08:00:00Z', { metadata: { routeBatchId: 42, packageId: 'NEW', photo: 'local://cotejo/new.jpg' } }),
      ],
    );

    const { data } = await service.findAll();

    expect(data[0].failures.map(({ packageId }) => packageId)).toEqual(['NEW']);
  });

  it('falls back to packageIds[0], and leaves photoUrl null without photo or when the storage cannot sign it', async () => {
    const getAccessUrl = vi.fn().mockRejectedValue(new Error('storage down'));
    const { service } = build(
      [stop(7)],
      [
        event(7, 'cotejo_failed', '2026-10-20T07:50:00Z', { metadata: { routeBatchId: 42, packageIds: ['PKG-3'], photo: 'local://cotejo/a.jpg' } }),
        event(7, 'cotejo_failed', '2026-10-20T07:51:00Z', { metadata: { routeBatchId: 42, packageId: 'PKG-4' } }),
      ],
      getAccessUrl,
    );

    const { data } = await service.findAll();

    expect(data[0].failures.map(({ packageId, photoUrl }) => [packageId, photoUrl])).toEqual([['PKG-3', null], ['PKG-4', null]]);
  });

  it('filters by assigned status, in_execution batch and a current cotejo_failed in the SQL', async () => {
    const { service, query } = build([stop(7)], []);

    await service.findAll();

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("s.name = 'assigned'");
    expect(sql).toContain("b.status = 'in_execution'");
    expect(sql).toContain("last.event_type = 'cotejo_failed'");
    expect(sql).toContain("e.metadata->>'routeBatchId' = d.route_batch_id::text");
  });
});
