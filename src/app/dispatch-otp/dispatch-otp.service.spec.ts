import { describe, expect, it, vi } from 'vitest';
import { DispatchOtpService } from './dispatch-otp.service.js';
import { matchesOtp } from './domain/otp-code.js';

function setup(overrides = {}) {
    const row = { id: 12, status: 'in_transit', evidence_policy: 'high_value_control', contact_phone: '+59170000000', driver_id: 7, ...overrides };
    const db = { query: vi.fn(async (sql: string) => sql.includes('SELECT') ? [row] : []) };
    const store = { issue: vi.fn().mockResolvedValue('issued'), readHash: vi.fn(), verify: vi.fn(), invalidate: vi.fn() };
    const sms = { send: vi.fn().mockResolvedValue(undefined) };
    const settings = { getNumber: vi.fn(async (key: string) => key === 'otp_code_length' ? 8 : 15) };
    return { row, db, store, sms, settings, service: new DispatchOtpService(db as any, store as any, sms as any, settings as any) };
}

describe('delivery OTP lifecycle', () => {
    it('issues on transit using settings and sends only transient plaintext', async () => {
        const x = setup();
        await x.service.onInTransit(12);
        const [id, hash, ttl, resend] = x.store.issue.mock.calls[0];
        expect([id, ttl, resend]).toEqual([12, 900, false]);
        const code = x.sms.send.mock.calls[0][0].body.match(/\d{8}/)![0];
        expect(await matchesOtp(code, hash)).toBe(true);
        expect(JSON.stringify(x.db.query.mock.calls)).not.toContain(code);
        expect(JSON.stringify(x.db.query.mock.calls)).toContain('otp_sent');
    });
    it.each([{ status: 'delivered' }, { evidence_policy: 'hand_delivery_standard' }])('ignores dispatch outside applicability %j', async (override) => {
        const x = setup(override);
        await x.service.onInTransit(12);
        expect(x.store.issue).not.toHaveBeenCalled();
        expect(x.sms.send).not.toHaveBeenCalled();
    });
    it.each([null, '', 'invalid'])('marks unusable source phone %s without generating an OTP', async (phone) => {
        const x = setup({ contact_phone: phone });
        await x.service.onInTransit(12);
        expect(x.store.issue).not.toHaveBeenCalled();
        expect(x.sms.send).not.toHaveBeenCalled();
        expect(JSON.stringify(x.db.query.mock.calls)).toContain('otp_resolution_required');
    });
    it('does not send again for duplicate status events', async () => {
        const x = setup();
        x.store.issue.mockResolvedValue('already_issued');
        await x.service.onInTransit(12);
        expect(x.sms.send).not.toHaveBeenCalled();
    });
    it('enforces ownership before accessing OTP state', async () => {
        const x = setup();
        await expect(x.service.resend(12, 99)).rejects.toMatchObject({ status: 403 });
        expect(x.store.issue).not.toHaveBeenCalled();
    });
    it('resends through the same bounded store without returning the code', async () => {
        const x = setup();
        const result = await x.service.resend(12, 7);
        expect(x.store.issue.mock.calls[0][3]).toBe(true);
        expect(Object.keys(result)).toEqual(['sent', 'expiresAt']);
        x.store.issue.mockResolvedValue('resend_limit');
        await expect(x.service.resend(12, 7)).rejects.toMatchObject({ response: { error: 'OTP_RESEND_LIMIT' } });
        expect(x.sms.send).toHaveBeenCalledTimes(1);
    });
    it('recovers an initial Redis failure with atomic first issuance through resend', async () => {
        const x = setup();
        x.store.issue.mockResolvedValueOnce('not_issued').mockResolvedValueOnce('issued');
        expect((await x.service.resend(12, 7)).sent).toBe(true);
        expect(x.store.issue.mock.calls.map((args) => args[3])).toEqual([true, false]);
        expect(x.sms.send).toHaveBeenCalledTimes(1);
    });
    it('reports a competing initial issuance without mislabelling the valid phone', async () => {
        const x = setup();
        x.store.issue.mockResolvedValueOnce('not_issued').mockResolvedValueOnce('already_issued');
        await expect(x.service.resend(12, 7)).rejects.toMatchObject({ response: { error: 'OTP_ALREADY_ISSUED' } });
        expect(x.sms.send).not.toHaveBeenCalled();
    });
    it.each(['locked', 'consumed'])('preserves %s verdict when the code hash has been removed', async (verdict) => {
        const x = setup();
        x.store.readHash.mockResolvedValue(null);
        x.store.verify.mockResolvedValue(verdict);
        expect(await x.service.verify(12, '123456')).toBe(verdict);
        expect(x.store.verify).toHaveBeenCalledWith(12, '', false);
    });
    it('invalidates precisely the failed generation and records no provider error content', async () => {
        const x = setup();
        x.sms.send.mockRejectedValue(new Error('secret code from provider'));
        await expect(x.service.onInTransit(12)).rejects.toMatchObject({ status: 503 });
        expect(x.store.invalidate).toHaveBeenCalledWith(12, x.store.issue.mock.calls[0][1]);
        expect(JSON.stringify(x.db.query.mock.calls)).not.toContain('secret');
    });
});
