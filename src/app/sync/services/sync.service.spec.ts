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
    const dispatches = {
        isAssignedToDriver: vi.fn().mockResolvedValue(over.assigned ?? true),
        updateStatus:       vi.fn(),
        getStatusName:      vi.fn().mockResolvedValue('pending'),       // current status of the dispatch
        getStatusNameById:  vi.fn().mockResolvedValue('in_transit'),    // status the event asks for
    };
    const storage = { upload: vi.fn().mockResolvedValue({ url: 'http://x/uploads/a.png' }) };
    const service = new SyncService(dataSource as any, events as any, incidents as any, evidences as any, dispatches as any, storage as any);
    return { service, events, incidents, evidences, dispatches, storage, manager };
}

const recent = () => new Date(Date.now() - 60_000).toISOString();
const statusEvent = (over: object = {}) => ({ type: SyncEventType.STATUS_CHANGE, clientEventId: ID1, dispatchId: 42, occurredAt: recent(), dispatchStatusId: 2, ...over }) as any;
const incidentEvent = (over: object = {}) => ({ type: SyncEventType.INCIDENT, clientEventId: ID1, dispatchId: 42, occurredAt: recent(), incidentReasonId: 2, ...over }) as any;
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

describe('SyncService — a finished dispatch cannot be reopened', () => {
    it.each(['delivered', 'returned'])('a %s dispatch does not accept another status (failed, nothing written)', async (finalStatus) => {
        const { service, dispatches, events } = build();
        dispatches.getStatusName.mockResolvedValue(finalStatus);
        dispatches.getStatusNameById.mockResolvedValue('pending');

        const { results } = await service.processBatch([statusEvent()], DRIVER);

        expect(results[0]).toMatchObject({ outcome: 'failed', error: `The dispatch is already ${finalStatus}: its status cannot change.` });
        expect(dispatches.updateStatus).not.toHaveBeenCalled();
        expect(events.create).not.toHaveBeenCalled();
    });

    it('repeating the same final status is harmless (applied)', async () => {
        const { service, dispatches } = build();
        dispatches.getStatusName.mockResolvedValue('delivered');
        dispatches.getStatusNameById.mockResolvedValue('delivered');

        expect((await service.processBatch([statusEvent()], DRIVER)).results[0].outcome).toBe('applied');
    });

    it.each(['pending', 'in_transit', 'not_delivered'])('a %s dispatch can still change (not_delivered can be retried)', async (status) => {
        const { service, dispatches } = build();
        dispatches.getStatusName.mockResolvedValue(status);

        expect((await service.processBatch([statusEvent()], DRIVER)).results[0].outcome).toBe('applied');
    });
});

describe('SyncService — occurredAt must be plausible', () => {
    const day = 86_400_000;
    it.each([
        ['in the year 2099', () => '2099-01-01T00:00:00.000Z'],
        ['more than an hour in the future', () => new Date(Date.now() + 2 * 3_600_000).toISOString()],
        ['more than 30 days old', () => new Date(Date.now() - 31 * day).toISOString()],
        ['in 1900', () => '1900-01-01T00:00:00.000Z'],
    ])('%s is failed (status change and incident)', async (_label, at) => {
        const { service, events, incidents } = build();

        const { results } = await service.processBatch([statusEvent({ occurredAt: at() }), incidentEvent({ clientEventId: ID1.replace('10', '13'), occurredAt: at() })], DRIVER);

        expect(results.map((r) => r.outcome)).toEqual(['failed', 'failed']);
        expect(results[0].error).toContain('occurredAt is not plausible');
        expect(events.create).not.toHaveBeenCalled();
        expect(incidents.create).not.toHaveBeenCalled();
    });

    it('a few minutes of clock skew, or an event from yesterday, is fine', async () => {
        const { service } = build();
        const results = (await service.processBatch([
            statusEvent({ occurredAt: new Date(Date.now() + 5 * 60_000).toISOString() }),
            statusEvent({ clientEventId: ID1.replace('10', '14'), occurredAt: new Date(Date.now() - day).toISOString() }),
        ], DRIVER)).results;

        expect(results.map((r) => r.outcome)).toEqual(['applied', 'applied']);
    });

    it('a retry of an event already saved stays already_processed even if its time is now old', async () => {
        const { service, events } = build();
        events.existsByClientEventId.mockResolvedValue(true);

        expect((await service.processBatch([statusEvent({ occurredAt: '2020-01-01T00:00:00.000Z' })], DRIVER)).results[0].outcome).toBe('already_processed');
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
