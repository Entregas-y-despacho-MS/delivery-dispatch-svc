import { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { StoragePort } from '../../../../plugins/storage/storage.port.js';
import { RouteBatchCotejoPhotoService } from './route-batch-cotejo-photo.service.js';

const photoId = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10';
const savedAt = new Date('2026-10-20T07:42:00.000Z');
const jpeg = {
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
  mimetype: 'image/jpeg',
} as Express.Multer.File;

function setup(
  options: {
    batch?: { status: string; driver_id: number | null }[];
    prior?: { route_batch_id: number; created_at: Date }[];
  } = {},
) {
  const inserts: unknown[][] = [];
  const manager = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM route_batches'))
        return options.batch ?? [{ status: 'confirmed', driver_id: 7 }];
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM route_batch_events')) return options.prior ?? [];
      if (sql.includes('INSERT INTO route_batch_events')) {
        inserts.push(params);
        return [{ created_at: savedAt }];
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  const dataSource = {
    transaction: vi.fn(async (work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  } as unknown as DataSource;
  const storage = {
    upload: vi.fn(async () => ({ url: 'local://cotejo/photo.jpg' })),
  } as unknown as StoragePort;
  return {
    service: new RouteBatchCotejoPhotoService(dataSource, storage),
    storage,
    inserts,
  };
}

describe('RouteBatchCotejoPhotoService', () => {
  it('stores the photo and records it in the batch event log', async () => {
    const { service, storage, inserts } = setup();
    const result = await service.upload(5, 7, { photoId }, jpeg);
    expect(result).toEqual({
      photo: { photoId, uploadedAt: savedAt.toISOString() },
      created: true,
    });
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][3]).toContain('local://cotejo/photo.jpg');
  });

  it('answers the original record when the photoId was already stored', async () => {
    const { service, storage } = setup({
      prior: [{ route_batch_id: 5, created_at: savedAt }],
    });
    const result = await service.upload(5, 7, { photoId }, jpeg);
    expect(result.created).toBe(false);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('rejects a photoId that belongs to another batch with 409', async () => {
    const { service } = setup({
      prior: [{ route_batch_id: 9, created_at: savedAt }],
    });
    await expect(
      service.upload(5, 7, { photoId }, jpeg),
    ).rejects.toMatchObject({
      response: { error: 'COTEJO_PHOTO_ID_CONFLICT' },
    });
  });

  it('rejects a batch that does not exist with 404', async () => {
    const { service } = setup({ batch: [] });
    await expect(
      service.upload(5, 7, { photoId }, jpeg),
    ).rejects.toMatchObject({
      response: { error: 'ROUTE_BATCH_NOT_FOUND' },
    });
  });

  it("rejects another driver's batch with 403 before touching the storage", async () => {
    const { service, storage } = setup({
      batch: [{ status: 'confirmed', driver_id: 8 }],
    });
    await expect(service.upload(5, 7, { photoId }, jpeg)).rejects.toMatchObject(
      { status: 403 },
    );
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('rejects a batch that is not confirmed with 409', async () => {
    const { service } = setup({
      batch: [{ status: 'pending_final_review', driver_id: 7 }],
    });
    await expect(
      service.upload(5, 7, { photoId }, jpeg),
    ).rejects.toMatchObject({
      response: { error: 'ROUTE_BATCH_NOT_CONFIRMED' },
    });
  });

  it('rejects a missing file with 400 and a non-JPEG with 415', async () => {
    const { service, storage } = setup();
    await expect(
      service.upload(5, 7, { photoId }, undefined),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.upload(
        5,
        7,
        { photoId },
        {
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          mimetype: 'image/png',
        } as Express.Multer.File,
      ),
    ).rejects.toMatchObject({ status: 415 });
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
