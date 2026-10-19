/// <reference types="multer" />
import { describe, expect, it, vi } from 'vitest';
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
    const dispatches = { existsById: vi.fn().mockResolvedValue(true), isAssignedToDriver: vi.fn().mockResolvedValue(true) };
    const storage = { upload: vi.fn().mockResolvedValue({ url: 'https://files/x.png' }) };
    const otp = { validate: vi.fn().mockResolvedValue(undefined) };
    const events = { emit: vi.fn() };
    return { evidences, dispatches, storage, otp, events, service: new DispatchEvidenceService(evidences as any, dispatches as any, storage as any, otp as any, events as any) };
}

describe('DispatchEvidenceService', () => {
    it('stores the file, saves only its URL and announces the evidence', async () => {
        const x = setup();
        const result = await x.service.register(42, 7, dto(), file);
        expect(result.created).toBe(true);
        expect(x.storage.upload).toHaveBeenCalledTimes(1);
        expect(x.evidences.create).toHaveBeenCalledWith(expect.objectContaining({ id: EVIDENCE_ID, dispatchId: 42, type: 'signature', fileUrl: 'https://files/x.png', receiverName: 'Maria Lopez' }));
        expect(JSON.stringify(result.evidence)).not.toContain('files/x.png');
        expect(x.events.emit).toHaveBeenCalledWith(DISPATCH_EVIDENCE_REGISTERED_EVENT, { dispatchId: 42, evidenceId: EVIDENCE_ID, type: 'signature', registeredAt: CREATED_AT.toISOString() });
    });

    it('drops the receiver of a photo', async () => {
        const x = setup();
        const jpeg = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mimetype: 'image/jpeg' } as Express.Multer.File;
        await x.service.register(42, 7, dto({ type: 'photo' }), jpeg);
        expect(x.evidences.create).toHaveBeenCalledWith(expect.objectContaining({ receiverName: null, receiverDocument: null }));
    });

    it('answers the original record, without uploading or announcing again, when the evidenceId exists', async () => {
        const x = setup();
        x.evidences.findById.mockResolvedValue({ id: EVIDENCE_ID, dispatchId: 42, type: 'signature', capturedAt: null, latitude: null, longitude: null, receiverName: null, receiverDocument: null, createdAt: CREATED_AT });
        const result = await x.service.register(42, 7, dto(), undefined);
        expect(result.created).toBe(false);
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

    it('registers an otp evidence only after the code is validated, with no file and no code', async () => {
        const x = setup();
        const evidence = await x.service.validateOtp(42, 7, '123456');
        expect(x.otp.validate).toHaveBeenCalledWith(42, 7, '123456');
        const [data] = x.evidences.create.mock.calls[0];
        expect(data).toMatchObject({ dispatchId: 42, type: 'otp' });
        expect(JSON.stringify([data, evidence])).not.toContain('123456');
        expect(x.events.emit).toHaveBeenCalledWith(DISPATCH_EVIDENCE_REGISTERED_EVENT, expect.objectContaining({ dispatchId: 42, type: 'otp' }));
    });

    it('registers and announces nothing when the code is rejected', async () => {
        const x = setup();
        x.otp.validate.mockRejectedValue(Object.assign(new Error('locked'), { status: 423 }));
        await expect(x.service.validateOtp(42, 7, '000000')).rejects.toMatchObject({ status: 423 });
        expect(x.evidences.create).not.toHaveBeenCalled();
        expect(x.events.emit).not.toHaveBeenCalled();
    });
});
