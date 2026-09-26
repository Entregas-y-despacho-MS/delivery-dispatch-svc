// SyncService (RF-U13): a driver may only sync their own dispatches, references that do not exist are
// reported clearly, and an evidence needs what it claims to be. All mocked — no DB.
import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { SyncService } from './sync.service.js';
import { SyncEventType } from '../dto/sync-event-type.enum.js';

const ID1 = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10';
const DRIVER = 5;

function build(over: { assigned?: boolean } = {}) {
    const manager = {};
    const dataSource = { transaction: vi.fn(async (cb: any) => cb(manager)) };
    const events    = { existsByClientEventId: vi.fn().mockResolvedValue(false), create: vi.fn() };
    const incidents = { existsById: vi.fn().mockResolvedValue(false), create: vi.fn() };
    const evidences = { existsById: vi.fn().mockResolvedValue(false), create: vi.fn() };
    const dispatches = { isAssignedToDriver: vi.fn().mockResolvedValue(over.assigned ?? true), updateStatus: vi.fn() };
    const storage = { upload: vi.fn().mockResolvedValue({ url: 'http://x/uploads/a.png' }) };
    const service = new SyncService(dataSource as any, events as any, incidents as any, evidences as any, dispatches as any, storage as any);
    return { service, events, incidents, evidences, dispatches, storage, manager };
}

const statusEvent = (over: object = {}) => ({ type: SyncEventType.STATUS_CHANGE, clientEventId: ID1, dispatchId: 42, occurredAt: '2026-09-22T14:03:00.000Z', dispatchStatusId: 2, ...over }) as any;
const incidentEvent = (over: object = {}) => ({ type: SyncEventType.INCIDENT, clientEventId: ID1, dispatchId: 42, occurredAt: '2026-09-22T14:03:00.000Z', incidentReasonId: 2, ...over }) as any;
const fkError = (column: string) => new QueryFailedError('UPDATE ...', [], Object.assign(new Error('fk'), { code: '23503', detail: `Key (${column})=(999) is not present in table "x".` }));

describe('SyncService.processBatch — a driver only syncs their own dispatches', () => {
    it('checks the dispatch against the calling driver, inside the event transaction', async () => {
        const { service, dispatches, manager } = build();

        await service.processBatch([statusEvent()], DRIVER);

        expect(dispatches.isAssignedToDriver).toHaveBeenCalledWith(42, DRIVER, { manager });
    });

    it('a dispatch that is not on the driver\'s route → failed "Dispatch not found." and nothing is written', async () => {
        const { service, dispatches, events, incidents } = build({ assigned: false });

        const { results } = await service.processBatch([statusEvent(), incidentEvent({ clientEventId: ID1.replace('10', '11') })], DRIVER);

        expect(results.map((r) => [r.outcome, r.error])).toEqual([['failed', 'Dispatch not found.'], ['failed', 'Dispatch not found.']]);
        expect(dispatches.updateStatus).not.toHaveBeenCalled();
        expect(events.create).not.toHaveBeenCalled();
        expect(incidents.create).not.toHaveBeenCalled();
    });

    it('an unknown dispatch and someone else\'s dispatch answer identically (no probing of other routes)', async () => {
        const { service } = build({ assigned: false });
        const { results } = await service.processBatch([statusEvent({ dispatchId: 999999 }), statusEvent({ dispatchId: 1 })], DRIVER);
        expect(results[0].error).toBe(results[1].error);
    });

    it('their own dispatch is applied', async () => {
        const { service, dispatches, events } = build();

        const { results } = await service.processBatch([statusEvent()], DRIVER);

        expect(results[0].outcome).toBe('applied');
        expect(dispatches.updateStatus).toHaveBeenCalledWith(42, 2, expect.anything());
        expect(events.create).toHaveBeenCalled();
    });

    it('an event that was already processed stays already_processed (idempotent retry)', async () => {
        const { service, events } = build();
        events.existsByClientEventId.mockResolvedValue(true);

        const { results } = await service.processBatch([statusEvent()], DRIVER);

        expect(results[0].outcome).toBe('already_processed');
    });

    it('a failed event does not stop the next ones', async () => {
        const { service, dispatches } = build();
        dispatches.isAssignedToDriver.mockResolvedValueOnce(false).mockResolvedValue(true);

        const { results } = await service.processBatch([statusEvent(), statusEvent({ clientEventId: ID1.replace('10', '12') })], DRIVER);

        expect(results.map((r) => r.outcome)).toEqual(['failed', 'applied']);
    });
});

describe('SyncService — references that do not exist are reported clearly (it used to be "Unexpected error.")', () => {
    it('unknown dispatch status', async () => {
        const { service, dispatches } = build();
        dispatches.updateStatus.mockRejectedValue(fkError('dispatch_status_id'));

        const { results } = await service.processBatch([statusEvent({ dispatchStatusId: 999 })], DRIVER);

        expect(results[0]).toMatchObject({ outcome: 'failed', error: 'The given dispatch status does not exist.' });
    });

    it('unknown incident reason', async () => {
        const { service, incidents } = build();
        incidents.create.mockRejectedValue(fkError('incident_reason_id'));

        const { results } = await service.processBatch([incidentEvent({ incidentReasonId: 999 })], DRIVER);

        expect(results[0]).toMatchObject({ outcome: 'failed', error: 'The given incident reason does not exist.' });
    });

    it('a numeric value out of range', async () => {
        const { service, dispatches } = build();
        dispatches.updateStatus.mockRejectedValue(new QueryFailedError('UPDATE', [], Object.assign(new Error('x'), { code: '22003' })));

        expect((await service.processBatch([statusEvent()], DRIVER)).results[0].error).toBe('A numeric value is out of range.');
    });

    it('any other failure stays a generic message (no internals leaked)', async () => {
        const { service, dispatches } = build();
        dispatches.updateStatus.mockRejectedValue(new Error('connection refused to 10.0.0.5'));

        expect((await service.processBatch([statusEvent()], DRIVER)).results[0].error).toBe('Unexpected error.');
    });
});

describe('SyncService.syncEvidence', () => {
    const png = { buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' } as any;
    const dto = (over: object = {}) => ({ clientEventId: ID1, dispatchId: 42, type: 'photo', ...over }) as any;

    it('a photo with its file is stored and recorded', async () => {
        const { service, storage, evidences } = build();

        const result = await service.syncEvidence(dto(), png, DRIVER);

        expect(result.outcome).toBe('applied');
        expect(storage.upload).toHaveBeenCalledWith({ buffer: png.buffer, filename: 'a.png', mimeType: 'image/png' });
        expect(evidences.create).toHaveBeenCalledWith(expect.objectContaining({ id: ID1, dispatchId: 42, type: 'photo', fileUrl: 'http://x/uploads/a.png' }));
    });

    it('a photo or signature without a file is failed (there is nothing to record)', async () => {
        const { service, evidences } = build();

        for (const type of ['photo', 'signature']) {
            const result = await service.syncEvidence(dto({ type }), undefined, DRIVER);
            expect(result).toMatchObject({ outcome: 'failed', error: 'A photo or signature evidence needs its file.' });
        }
        expect(evidences.create).not.toHaveBeenCalled();
    });

    it('an otp without its code is failed; with it, applied and no file needed', async () => {
        const { service } = build();

        expect(await service.syncEvidence(dto({ type: 'otp' }), undefined, DRIVER)).toMatchObject({ outcome: 'failed', error: 'An otp evidence needs its otpCode.' });
        expect((await service.syncEvidence(dto({ type: 'otp', otpCode: '123456' }), undefined, DRIVER)).outcome).toBe('applied');
    });

    it('someone else\'s dispatch → failed "Dispatch not found." and nothing is uploaded', async () => {
        const { service, storage } = build({ assigned: false });

        const result = await service.syncEvidence(dto(), png, DRIVER);

        expect(result).toMatchObject({ outcome: 'failed', error: 'Dispatch not found.' });
        expect(storage.upload).not.toHaveBeenCalled();
    });

    it('a retry of an evidence already saved is already_processed, before any other check', async () => {
        const { service, evidences, dispatches } = build({ assigned: false });
        evidences.existsById.mockResolvedValue(true);

        expect((await service.syncEvidence(dto(), png, DRIVER)).outcome).toBe('already_processed');
        expect(dispatches.isAssignedToDriver).not.toHaveBeenCalled();
    });
});
