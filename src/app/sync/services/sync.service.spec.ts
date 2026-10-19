// SyncService (RF-U13): a driver may only sync their own dispatches, references that do not exist are
// reported clearly, and an evidence needs what it claims to be. All mocked — no DB.
import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { SyncService } from './sync.service.js';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../../dispatch-status/dispatch-status-changed.event.js';
import { SyncEventType } from '../dto/sync-event-type.enum.js';

const ID1 = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10';
const DRIVER = 5;

function build(over: { assigned?: boolean; targetStatus?: string; currentStatus?: string | null; reasonCode?: string; evidencePolicy?: string; hasOtpEvidence?: boolean; routeStatus?: string; routeStartedAt?: string | null; routeClosedAt?: string | null } = {}) {
    const manager = { query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT version, updated_at')) return [{ version: 4, updated_at: '2026-10-18T12:00:00.000Z' }];
        if (sql.includes('incident_reasons')) return [{ code: over.reasonCode ?? 'DAMAGED_PACKAGE' }];
        if (sql.includes('LEFT JOIN LATERAL') && sql.includes('route_batch_events')) return [{
            status: over.routeStatus ?? 'in_execution',
            started_at: over.routeStartedAt === undefined ? '2026-01-01T00:00:00.000Z' : over.routeStartedAt,
            closed_at: over.routeClosedAt ?? null,
        }];
        return [{ dispatch_id: 42, evidence_policy: over.evidencePolicy ?? 'standard_photo' }];
    }) };
    const dataSource = { transaction: vi.fn(async (cb: any) => cb(manager)) };
    const events    = { existsByClientEventId: vi.fn().mockResolvedValue(false), create: vi.fn() };
    const incidents = { existsById: vi.fn().mockResolvedValue(false), create: vi.fn() };
    const evidences = { existsByDispatchAndType: vi.fn().mockResolvedValue(over.hasOtpEvidence ?? false), existsById: vi.fn().mockResolvedValue(false), create: vi.fn() };
    const dispatches = {
        isAssignedToDriver: vi.fn().mockResolvedValue(over.assigned ?? true),
        updateStatus:       vi.fn(),
        getStatusName:      vi.fn().mockResolvedValue(over.currentStatus === undefined ? 'out_for_delivery' : over.currentStatus),
        getStatusNameById:  vi.fn().mockResolvedValue(over.targetStatus ?? 'in_transit'),
        getStatusIdByName:  vi.fn().mockResolvedValue(7),
    };
    const statusPublication = { publish: vi.fn().mockResolvedValue(1) };
    const storage = { upload: vi.fn().mockResolvedValue({ url: 'http://x/uploads/a.png' }) };
    const emitter = { emit: vi.fn() };
    const service = new SyncService(dataSource as any, events as any, incidents as any, evidences as any, dispatches as any, storage as any, statusPublication as any, emitter as any);
    return { service, events, incidents, evidences, dispatches, storage, manager, statusPublication, emitter, dataSource };
}

const recent = () => new Date(Date.now() - 60_000).toISOString();
const statusEvent = (over: object = {}) => ({ type: SyncEventType.STATUS_CHANGE, clientEventId: ID1, dispatchId: 42, occurredAt: recent(), dispatchStatusId: 2, ...over }) as any;
const incidentEvent = (over: object = {}) => ({ type: SyncEventType.INCIDENT, clientEventId: ID1, dispatchId: 42, occurredAt: recent(), incidentReasonId: 2, ...over }) as any;
const fkError = (column: string, detail = `Key (${column})=(999) is not present in table "x".`) => new QueryFailedError('UPDATE ...', [], Object.assign(new Error('fk'), { code: '23503', detail }));

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
        const { service, dispatches, events, statusPublication } = build();

        const { results } = await service.processBatch([statusEvent()], DRIVER);

        expect(results[0].outcome).toBe('applied');
        // in_transit is not a final status: no closing time is passed (ST-55.2)
        expect(dispatches.updateStatus).toHaveBeenCalledWith(42, 2, expect.anything(), undefined);
        expect(events.create).toHaveBeenCalled();
        expect(statusPublication.publish).not.toHaveBeenCalled();
    });

    it.each(['delivered', 'not_delivered'])('closes the dispatch at the time %s happened on the device, not when the sync arrives', async (status) => {
        const { service, dispatches, manager } = build({ targetStatus: status, currentStatus: 'in_transit' });
        const occurredAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();

        await service.processBatch([statusEvent({ dispatchStatusId: 9, occurredAt })], DRIVER);

        expect(dispatches.updateStatus).toHaveBeenCalledWith(42, 9, { manager }, new Date(occurredAt));
    });

    it('does not move the closing time when the same final status is sent again', async () => {
        const { service, dispatches, manager } = build({ targetStatus: 'delivered', currentStatus: 'delivered' });

        await service.processBatch([statusEvent({ dispatchStatusId: 9 })], DRIVER);

        expect(dispatches.updateStatus).toHaveBeenCalledWith(42, 9, { manager }, undefined);
    });

    it.each(['delivered', 'not_delivered'])('publishes %s from offline status sync in the same transaction', async (status) => {
        const { service, statusPublication, events, manager } = build({ targetStatus: status, currentStatus: 'in_transit' });
        const occurredAt = recent();

        const result = (await service.processBatch([statusEvent({ dispatchStatusId: 9, occurredAt })], DRIVER)).results[0];
        expect(result.outcome).toBe('applied');
        expect(statusPublication.publish).toHaveBeenCalledWith(manager, {
            dispatchId: 42, status, previousStatus: 'in_transit', occurredAt: new Date(occurredAt),
        });
        expect(events.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ previousStatus: 'in_transit', status, outboundRecordVersion: 1 }),
        }), { manager });
    });

    it.each(['returned', 'cancelled', 'incident'])('does not let a driver sync coordinator-only status %s', async (status) => {
        const { service, dispatches, events, statusPublication } = build({ targetStatus: status });

        const result = (await service.processBatch([statusEvent({ dispatchStatusId: 9 })], DRIVER)).results[0];

        expect(result.outcome).toBe('failed');
        expect(dispatches.updateStatus).not.toHaveBeenCalled();
        expect(events.create).not.toHaveBeenCalled();
        expect(statusPublication.publish).not.toHaveBeenCalled();
    });

    it('rejects a sync event outside the route execution window without writing it', async () => {
        const { service, dispatches, events, incidents, statusPublication } = build({ routeStatus: 'confirmed' });

        const result = (await service.processBatch([statusEvent()], DRIVER)).results[0];

        expect(result).toMatchObject({ outcome: 'failed', error: 'The dispatch event is outside the route execution window.' });
        expect(dispatches.updateStatus).not.toHaveBeenCalled();
        expect(events.create).not.toHaveBeenCalled();
        expect(incidents.create).not.toHaveBeenCalled();
        expect(statusPublication.publish).not.toHaveBeenCalled();
    });

    it('rejects an in-execution batch without its route_started timestamp', async () => {
        const { service, dispatches, events } = build({ routeStartedAt: null });

        const result = (await service.processBatch([statusEvent()], DRIVER)).results[0];

        expect(result).toMatchObject({ outcome: 'failed', error: 'The dispatch event is outside the route execution window.' });
        expect(dispatches.updateStatus).not.toHaveBeenCalled();
        expect(events.create).not.toHaveBeenCalled();
    });

    it('accepts an offline event recorded before an already closed route ended', async () => {
        const { service, events } = build({ routeStatus: 'closed', routeClosedAt: new Date().toISOString() });

        const result = (await service.processBatch([statusEvent()], DRIVER)).results[0];

        expect(result.outcome).toBe('applied');
        expect(events.create).toHaveBeenCalled();
    });

    it('accepts an offline event within five minutes before the server route start time', async () => {
        const occurredAt = new Date(Date.now() - 60_000);
        const routeStartedAt = new Date(occurredAt.getTime() + 4 * 60_000).toISOString();
        const { service, dispatches, events } = build({ routeStartedAt });

        const result = (await service.processBatch([statusEvent({ occurredAt: occurredAt.toISOString() })], DRIVER)).results[0];

        expect(result.outcome).toBe('applied');
        expect(dispatches.updateStatus).toHaveBeenCalled();
        expect(events.create).toHaveBeenCalled();
    });

    it('rejects an offline event more than five minutes before route start', async () => {
        const occurredAt = new Date(Date.now() - 60_000);
        const routeStartedAt = new Date(occurredAt.getTime() + 6 * 60_000).toISOString();
        const { service, dispatches, events } = build({ routeStartedAt });

        const result = (await service.processBatch([statusEvent({ occurredAt: occurredAt.toISOString() })], DRIVER)).results[0];

        expect(result).toMatchObject({ outcome: 'failed', error: 'The dispatch event is outside the route execution window.' });
        expect(dispatches.updateStatus).not.toHaveBeenCalled();
        expect(events.create).not.toHaveBeenCalled();
    });

    it('accepts an offline event within five minutes after the server route close time', async () => {
        const occurredAt = new Date(Date.now() - 60_000);
        const routeClosedAt = new Date(occurredAt.getTime() - 4 * 60_000).toISOString();
        const { service, dispatches, events } = build({ routeStatus: 'closed', routeClosedAt });

        const result = (await service.processBatch([statusEvent({ occurredAt: occurredAt.toISOString() })], DRIVER)).results[0];

        expect(result.outcome).toBe('applied');
        expect(dispatches.updateStatus).toHaveBeenCalled();
        expect(events.create).toHaveBeenCalled();
    });

    it('rejects an offline event more than five minutes after route close', async () => {
        const occurredAt = new Date(Date.now() - 60_000);
        const routeClosedAt = new Date(occurredAt.getTime() - 6 * 60_000).toISOString();
        const { service, dispatches, events } = build({ routeStatus: 'closed', routeClosedAt });

        const result = (await service.processBatch([statusEvent({ occurredAt: occurredAt.toISOString() })], DRIVER)).results[0];

        expect(result).toMatchObject({ outcome: 'failed', error: 'The dispatch event is outside the route execution window.' });
        expect(dispatches.updateStatus).not.toHaveBeenCalled();
        expect(events.create).not.toHaveBeenCalled();
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

    // `lc_messages` of the server translates the text of the error; the device must get the same message.
    it('reads the column when Postgres answers in Spanish', async () => {
        const { service, dispatches } = build();
        dispatches.updateStatus.mockRejectedValue(
            fkError('dispatch_status_id', 'La llave (dispatch_status_id)=(999) no está presente en la tabla «dispatch_statuses».'),
        );

        const { results } = await service.processBatch([statusEvent({ dispatchStatusId: 999 })], DRIVER);

        expect(results[0]).toMatchObject({ outcome: 'failed', error: 'The given dispatch status does not exist.' });
    });

    it('falls back to the generic message when the error carries no detail', async () => {
        const { service, incidents } = build();
        incidents.create.mockRejectedValue(fkError('incident_reason_id', null as unknown as string));

        const { results } = await service.processBatch([incidentEvent({ incidentReasonId: 999 })], DRIVER);

        expect(results[0]).toMatchObject({ outcome: 'failed', error: 'A referenced record does not exist.' });
    });

    it('falls back to the generic message for a composite key it cannot name', async () => {
        const { service, dispatches } = build();
        dispatches.updateStatus.mockRejectedValue(fkError('x', 'Key (a, b)=(1, 2) is not present in table "x".'));

        const { results } = await service.processBatch([statusEvent({ dispatchStatusId: 999 })], DRIVER);

        expect(results[0]).toMatchObject({ outcome: 'failed', error: 'A referenced record does not exist.' });
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

describe('SyncService — offline incidents publish the result atomically', () => {
    it('moves the dispatch to incident and records reason/outbox version in the same transaction', async () => {
        const { service, dispatches, incidents, events, statusPublication, manager } = build({ currentStatus: 'out_for_delivery' });
        const occurredAt = recent();

        const result = (await service.processBatch([incidentEvent({ occurredAt })], DRIVER)).results[0];

        expect(result.outcome).toBe('applied');
        expect(dispatches.getStatusIdByName).toHaveBeenCalledWith('incident', { manager });
        expect(dispatches.updateStatus).toHaveBeenCalledWith(42, 7, { manager });
        expect(statusPublication.publish).toHaveBeenCalledWith(manager, {
            dispatchId: 42, status: 'incident', previousStatus: 'out_for_delivery', occurredAt: new Date(occurredAt), reasonCode: 'DAMAGED_PACKAGE',
        });
        expect(incidents.create).toHaveBeenCalledWith(expect.objectContaining({ id: ID1, dispatchId: 42 }), { manager });
        expect(events.create).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'status_changed', clientEventId: ID1, reason: 'DAMAGED_PACKAGE',
            metadata: expect.objectContaining({ status: 'incident', previousStatus: 'out_for_delivery', outboundRecordVersion: 1 }),
        }), { manager });
    });

    it('does not change a finished dispatch to incident', async () => {
        const { service, dispatches, incidents, events } = build({ currentStatus: 'delivered' });

        const result = (await service.processBatch([incidentEvent()], DRIVER)).results[0];

        expect(result.outcome).toBe('failed');
        expect(result.error).toContain('already delivered');
        expect(dispatches.updateStatus).not.toHaveBeenCalled();
        expect(incidents.create).not.toHaveBeenCalled();
        expect(events.create).not.toHaveBeenCalled();
    });

    it('does not publish on a duplicate incident event ID', async () => {
        const { service, incidents, statusPublication } = build();
        incidents.existsById.mockResolvedValue(true);

        expect((await service.processBatch([incidentEvent()], DRIVER)).results[0].outcome).toBe('already_processed');
        expect(statusPublication.publish).not.toHaveBeenCalled();
    });
});

describe('SyncService.syncEvidence', () => {
    const png = { buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' } as any;
    const dto = (over: object = {}) => ({ clientEventId: ID1, dispatchId: 42, type: 'photo', ...over }) as any;

    it('a photo with its file is stored and recorded', async () => {
        const { service, storage, evidences, emitter } = build();
        evidences.create.mockResolvedValue({
            id: ID1,
            type: 'photo',
            createdAt: new Date('2026-10-19T12:00:00.000Z'),
        });

        const result = await service.syncEvidence(dto(), png, DRIVER);

        expect(result.outcome).toBe('applied');
        expect(storage.upload).toHaveBeenCalledWith({ buffer: png.buffer, filename: 'a.png', mimeType: 'image/png' });
        expect(evidences.create).toHaveBeenCalledWith(expect.objectContaining({ id: ID1, dispatchId: 42, type: 'photo', fileUrl: 'http://x/uploads/a.png' }));
        expect(emitter.emit).toHaveBeenCalledWith('dispatch.evidence_registered', {
            dispatchId: 42,
            evidenceId: ID1,
            type: 'photo',
            registeredAt: '2026-10-19T12:00:00.000Z',
        });
    });

    it('a photo or signature without a file is failed (there is nothing to record)', async () => {
        const { service, evidences } = build();

        for (const type of ['photo', 'signature']) {
            const result = await service.syncEvidence(dto({ type }), undefined, DRIVER);
            expect(result).toMatchObject({ outcome: 'failed', error: 'A photo or signature evidence needs its file.' });
        }
        expect(evidences.create).not.toHaveBeenCalled();
    });

    it.each([undefined, '123456'])('rejects legacy OTP with code %s without recording or uploading it', async (otpCode) => {
        const { service, evidences, storage } = build();
        const result = await service.syncEvidence(dto({ type: 'otp', otpCode }), png, DRIVER);
        expect(result).toMatchObject({ outcome: 'failed', error: 'Legacy OTP submissions are rejected. Online validation belongs to ST-31.3.' });
        expect(evidences.create).not.toHaveBeenCalled();
        expect(storage.upload).not.toHaveBeenCalled();
    });

    it('does not acknowledge a legacy OTP row as verified on retry', async () => {
        const { service, evidences } = build();
        evidences.existsById.mockResolvedValue(true);
        expect((await service.syncEvidence(dto({ type: 'otp', otpCode: '123456' }), undefined, DRIVER)).outcome).toBe('failed');
        expect(evidences.existsById).not.toHaveBeenCalled();
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

 describe('SyncService — high value delivery requires validated OTP evidence', () => {
    it('rejects delivered before mutation or publication when OTP evidence is absent', async () => {
        const { service, dispatches, events, statusPublication, evidences, manager } = build({ targetStatus: 'delivered', currentStatus: 'in_transit', evidencePolicy: 'high_value_control' });
        const result = (await service.processBatch([statusEvent()], DRIVER)).results[0];
        expect(result).toMatchObject({ outcome: 'failed', error: 'The delivery requires otp evidence before it can be marked delivered.' });
        expect(evidences.existsByDispatchAndType).toHaveBeenCalledWith(42, 'otp', { manager });
        expect(dispatches.updateStatus).not.toHaveBeenCalled();
        expect(events.create).not.toHaveBeenCalled();
        expect(statusPublication.publish).not.toHaveBeenCalled();
    });

    it('allows delivered with OTP evidence in the event transaction', async () => {
        const { service, dispatches } = build({ targetStatus: 'delivered', currentStatus: 'in_transit', evidencePolicy: 'high_value_control', hasOtpEvidence: true });
        expect((await service.processBatch([statusEvent()], DRIVER)).results[0].outcome).toBe('applied');
        expect(dispatches.updateStatus).toHaveBeenCalled();
    });
});

describe('SyncService — OTP lifecycle sees only committed transitions', () => {
    it('emits in_transit with its persisted version after commit', async () => {
        const { service, dataSource, emitter } = build();
        let committed = false;
        const transaction = dataSource.transaction.getMockImplementation()!;
        dataSource.transaction.mockImplementation(async (cb: any) => {
            const result = await transaction(cb);
            committed = true;
            return result;
        });
        emitter.emit.mockImplementation(() => { expect(committed).toBe(true); });
        expect((await service.processBatch([statusEvent()], DRIVER)).results[0].outcome).toBe('applied');
        expect(emitter.emit).toHaveBeenCalledWith(DISPATCH_STATUS_CHANGED_EVENT, {
            dispatchId: 42, status: 'in_transit', previousStatus: 'out_for_delivery', version: 4, updatedAt: '2026-10-18T12:00:00.000Z',
        });
    });

    it('does not emit if commit fails after the transition was prepared', async () => {
        const { service, dataSource, emitter } = build();
        const transaction = dataSource.transaction.getMockImplementation()!;
        dataSource.transaction.mockImplementation(async (cb: any) => {
            await transaction(cb);
            throw new Error('commit failed');
        });
        expect((await service.processBatch([statusEvent()], DRIVER)).results[0].outcome).toBe('failed');
        expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('does not emit for duplicate or unchanged in_transit status', async () => {
        const { service, events, emitter } = build({ currentStatus: 'in_transit' });
        await service.processBatch([statusEvent()], DRIVER);
        events.existsByClientEventId.mockResolvedValue(true);
        await service.processBatch([statusEvent()], DRIVER);
        expect(emitter.emit).not.toHaveBeenCalled();
    });
});
