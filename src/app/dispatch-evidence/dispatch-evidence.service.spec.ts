/// <reference types="multer" />
import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { DispatchEvidenceService } from './dispatch-evidence.service.js';
import { DISPATCH_EVIDENCE_REGISTERED_EVENT } from './dispatch-evidence-registered.event.js';
import type { RegisterEvidenceDto } from './dto/register-evidence.dto.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const EVIDENCE_ID = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10';
const CREATED_AT = new Date('2026-10-18T14:05:00.000Z');

const dto = (override: Partial<RegisterEvidenceDto> = {}): RegisterEvidenceDto => ({
    evidenceId: EVIDENCE_ID, type: 'signature', capturedAt: '2026-10-18T14:03:00.000Z', lat: -17.78, lng: -63.18,
    receiverName: 'Maria Lopez', receiverDocument: '1234567', ...override,
});
const file = { buffer: PNG, mimetype: 'image/png' } as Express.Multer.File;

function setup() {
    const saved = (data: Record<string, unknown>) => ({ capturedAt: null, latitude: null, longitude: null, receiverName: null, receiverDocument: null, createdAt: CREATED_AT, ...data });
    const evidences = { findById: vi.fn().mockResolvedValue(null), create: vi.fn(async (data: Record<string, unknown>) => saved(data)) };
    const dispatches = { existsById: vi.fn().mockResolvedValue(true), isAssignedToDriver: vi.fn().mockResolvedValue(true), getStatusName: vi.fn().mockResolvedValue('in_transit') };
    const storage = { upload: vi.fn().mockResolvedValue({ url: 'https://files/x.png' }) };
    // By default a correct code that nobody had spent: validate hands back the id it was given.
    const otp = {
        validate: vi.fn(async (_dispatchId: number, _driverId: number, _code: string, evidenceId: string) => ({ evidenceId, alreadyConsumed: false })),
        markEvidenceNotSaved: vi.fn().mockResolvedValue(undefined),
    };
    const events = { emit: vi.fn() };
    const manager = { query: vi.fn().mockResolvedValue([]) };
    const dataSource = { transaction: vi.fn(async (work: (m: typeof manager) => Promise<unknown>) => await work(manager)) };
    return { evidences, dispatches, storage, otp, events, manager, dataSource, service: new DispatchEvidenceService(evidences as any, dispatches as any, storage as any, otp as any, events as any, dataSource as any) };
}

const duplicateKey = () => new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' }));

describe('DispatchEvidenceService.register', () => {
    it('stores the file, saves only its URL and announces the evidence', async () => {
        const x = setup();
        const result = await x.service.register(42, 7, dto(), file);
        expect(result.created).toBe(true);
        expect(x.storage.upload).toHaveBeenCalledTimes(1);
        expect(x.evidences.create).toHaveBeenCalledWith(expect.objectContaining({ id: EVIDENCE_ID, dispatchId: 42, type: 'signature', fileUrl: 'https://files/x.png', receiverName: 'Maria Lopez' }), { manager: x.manager });
        expect(JSON.stringify(result.evidence)).not.toContain('files/x.png');
        expect(x.events.emit).toHaveBeenCalledWith(DISPATCH_EVIDENCE_REGISTERED_EVENT, { dispatchId: 42, evidenceId: EVIDENCE_ID, type: 'signature', registeredAt: CREATED_AT.toISOString() });
    });

    it('takes the per-evidenceId lock before it looks again, uploads or inserts', async () => {
        const x = setup();
        await x.service.register(42, 7, dto(), file);
        const order = [x.manager.query.mock.invocationCallOrder[0], x.evidences.findById.mock.invocationCallOrder[1], x.storage.upload.mock.invocationCallOrder[0], x.evidences.create.mock.invocationCallOrder[0]];
        expect(x.manager.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [`dispatch-evidence:${EVIDENCE_ID}`]);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('answers the row a concurrent request saved while this one waited for the lock, without uploading', async () => {
        const x = setup();
        const winner = { id: EVIDENCE_ID, dispatchId: 42, type: 'signature', capturedAt: null, latitude: null, longitude: null, receiverName: null, receiverDocument: null, createdAt: CREATED_AT };
        x.evidences.findById.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
        const result = await x.service.register(42, 7, dto(), file);
        expect(result.created).toBe(false);
        expect(x.storage.upload).not.toHaveBeenCalled();
        expect(x.evidences.create).not.toHaveBeenCalled();
        expect(x.events.emit).not.toHaveBeenCalled();
    });

    it('refuses with 409, and leaves the row alone, when the id the winner saved belongs to another dispatch', async () => {
        const x = setup();
        x.evidences.findById.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: EVIDENCE_ID, dispatchId: 99, createdAt: CREATED_AT });
        await expect(x.service.register(42, 7, dto(), file)).rejects.toMatchObject({ status: 409, response: { error: 'EVIDENCE_ID_CONFLICT' } });
        expect(x.storage.upload).not.toHaveBeenCalled();
        expect(x.evidences.create).not.toHaveBeenCalled();
    });

    it('drops the receiver of a photo', async () => {
        const x = setup();
        const jpeg = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mimetype: 'image/jpeg' } as Express.Multer.File;
        await x.service.register(42, 7, dto({ type: 'photo' }), jpeg);
        expect(x.evidences.create).toHaveBeenCalledWith(expect.objectContaining({ receiverName: null, receiverDocument: null }), expect.anything());
    });

    it('answers the original record, without uploading or announcing again, when the evidenceId exists', async () => {
        const x = setup();
        x.evidences.findById.mockResolvedValue({ id: EVIDENCE_ID, dispatchId: 42, type: 'signature', capturedAt: null, latitude: null, longitude: null, receiverName: null, receiverDocument: null, createdAt: CREATED_AT });
        const result = await x.service.register(42, 7, dto(), undefined);
        expect(result.created).toBe(false);
        expect(x.dataSource.transaction).not.toHaveBeenCalled();
        expect(x.storage.upload).not.toHaveBeenCalled();
        expect(x.events.emit).not.toHaveBeenCalled();
    });

    it('rejects an evidenceId that belongs to another dispatch', async () => {
        const x = setup();
        x.evidences.findById.mockResolvedValue({ id: EVIDENCE_ID, dispatchId: 99, createdAt: CREATED_AT });
        await expect(x.service.register(42, 7, dto(), file)).rejects.toMatchObject({ status: 409 });
    });

    it('answers 404 for an unknown dispatch and 403 for another driver\'s, before touching the file', async () => {
        const x = setup();
        x.dispatches.existsById.mockResolvedValue(false);
        await expect(x.service.register(42, 7, dto(), file)).rejects.toMatchObject({ status: 404 });
        x.dispatches.existsById.mockResolvedValue(true);
        x.dispatches.isAssignedToDriver.mockResolvedValue(false);
        await expect(x.service.register(42, 7, dto(), file)).rejects.toMatchObject({ status: 403 });
        expect(x.storage.upload).not.toHaveBeenCalled();
    });

    it('rejects a capture time in the future and saves nothing', async () => {
        const x = setup();
        await expect(x.service.register(42, 7, dto({ capturedAt: new Date(Date.now() + 3_600_000).toISOString() }), file)).rejects.toMatchObject({ status: 400 });
        expect(x.storage.upload).not.toHaveBeenCalled();
    });

    it.each(['delivered', 'out_for_delivery', 'cancelled', null])('rejects new evidence when the dispatch is %s, before touching the file', async (status) => {
        const x = setup();
        x.dispatches.getStatusName.mockResolvedValue(status);
        await expect(x.service.register(42, 7, dto(), file)).rejects.toMatchObject({ status: 409, response: { error: 'DISPATCH_NOT_IN_TRANSIT' } });
        expect(x.storage.upload).not.toHaveBeenCalled();
        expect(x.evidences.create).not.toHaveBeenCalled();
    });

    it('still answers a retry of a registered evidence after the dispatch left transit', async () => {
        const x = setup();
        x.dispatches.getStatusName.mockResolvedValue('delivered');
        x.evidences.findById.mockResolvedValue({ id: EVIDENCE_ID, dispatchId: 42, type: 'signature', createdAt: CREATED_AT });
        await expect(x.service.register(42, 7, dto(), file)).resolves.toMatchObject({ created: false });
    });

    it('answers the original when a writer outside the lock got the same id in first', async () => {
        const x = setup();
        const original = { id: EVIDENCE_ID, dispatchId: 42, type: 'signature', createdAt: CREATED_AT };
        x.evidences.findById.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(original);
        x.evidences.create.mockRejectedValue(duplicateKey());
        await expect(x.service.register(42, 7, dto(), file)).resolves.toMatchObject({ created: false, evidence: { id: EVIDENCE_ID } });
        expect(x.events.emit).not.toHaveBeenCalled();
    });

    it('rethrows any other failure of the insert', async () => {
        const x = setup();
        x.evidences.create.mockRejectedValue(new Error('db down'));
        await expect(x.service.register(42, 7, dto(), file)).rejects.toThrow('db down');
    });

    it('does not fail a saved evidence when announcing it throws', async () => {
        const x = setup();
        x.events.emit.mockImplementation(() => { throw new Error('listener blew up'); });
        await expect(x.service.register(42, 7, dto(), file)).resolves.toMatchObject({ created: true });
        await expect(x.service.validateOtp(42, 7, '123456')).resolves.toMatchObject({ type: 'otp' });
    });
});

describe('DispatchEvidenceService.validateOtp', () => {
    it('registers an otp evidence under the id recorded with the consumption, with no file and no code', async () => {
        const x = setup();
        const evidence = await x.service.validateOtp(42, 7, '123456');
        const [dispatchId, driverId, code, evidenceId, manager] = x.otp.validate.mock.calls[0];
        expect([dispatchId, driverId, code, manager]).toEqual([42, 7, '123456', x.manager]);
        const [data] = x.evidences.create.mock.calls[0];
        expect(data).toMatchObject({ id: evidenceId, dispatchId: 42, type: 'otp' });
        expect(JSON.stringify([data, evidence])).not.toContain('123456');
        expect(x.manager.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['dispatch-otp-evidence:42']);
        expect(x.events.emit).toHaveBeenCalledWith(DISPATCH_EVIDENCE_REGISTERED_EVENT, expect.objectContaining({ dispatchId: 42, type: 'otp', evidenceId }));
    });

    it('registers and announces nothing when the code is rejected', async () => {
        const x = setup();
        x.otp.validate.mockRejectedValue(Object.assign(new Error('locked'), { status: 423 }));
        await expect(x.service.validateOtp(42, 7, '000000')).rejects.toMatchObject({ status: 423 });
        expect(x.evidences.create).not.toHaveBeenCalled();
        expect(x.events.emit).not.toHaveBeenCalled();
        expect(x.otp.markEvidenceNotSaved).not.toHaveBeenCalled();
    });

    it('leaves a marker for Dispatch, and still fails, when a correct code cannot be saved', async () => {
        const x = setup();
        x.evidences.create.mockRejectedValue(new Error('db down'));
        await expect(x.service.validateOtp(42, 7, '123456')).rejects.toThrow('db down');
        expect(x.otp.markEvidenceNotSaved).toHaveBeenCalledWith(42);
        expect(x.events.emit).not.toHaveBeenCalled();
    });

    it('keeps the original error when the marker cannot be written either', async () => {
        const x = setup();
        x.evidences.create.mockRejectedValue(new Error('db down'));
        x.otp.markEvidenceNotSaved.mockRejectedValue(new Error('marker failed'));
        await expect(x.service.validateOtp(42, 7, '123456')).rejects.toThrow('db down');
    });

    it('finishes the registration when the code was consumed earlier but its evidence was never saved', async () => {
        const x = setup();
        x.otp.validate.mockResolvedValue({ evidenceId: 'recorded-id', alreadyConsumed: true });
        const evidence = await x.service.validateOtp(42, 7, '123456');
        expect(x.evidences.findById).toHaveBeenCalledWith('recorded-id', { manager: x.manager });
        expect(x.evidences.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'recorded-id', dispatchId: 42, type: 'otp' }), { manager: x.manager });
        expect(evidence).toMatchObject({ id: 'recorded-id', type: 'otp' });
        expect(x.events.emit).toHaveBeenCalledTimes(1);
    });

    it('refuses a true second use: the consumed code already has its evidence', async () => {
        const x = setup();
        x.otp.validate.mockResolvedValue({ evidenceId: 'recorded-id', alreadyConsumed: true });
        x.evidences.findById.mockResolvedValue({ id: 'recorded-id', dispatchId: 42, type: 'otp', createdAt: CREATED_AT });
        await expect(x.service.validateOtp(42, 7, '123456')).rejects.toMatchObject({ status: 409, response: { error: 'OTP_CONSUMED' } });
        expect(x.evidences.create).not.toHaveBeenCalled();
        expect(x.events.emit).not.toHaveBeenCalled();
        expect(x.otp.markEvidenceNotSaved).not.toHaveBeenCalled();
    });
});
