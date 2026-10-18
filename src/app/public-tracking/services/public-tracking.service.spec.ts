import { describe, expect, it, vi } from 'vitest';
import { PublicTrackingService } from './public-tracking.service.js';
import { TrackingLinkNotFoundException } from '../exceptions/index.js';

const TOKEN = '5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f';
const NOTIFIED = new Date('2026-10-17T14:00:00Z');
const NOW = new Date('2026-10-17T16:00:00Z');

function row(overrides: Record<string, unknown> = {}) {
    return {
        dispatch_id: 7,
        status: 'scheduled',
        version: 1,
        tracking_code: 'TRK-000123',
        customer_confirmation: 'pending',
        promise_notified_at: NOTIFIED,
        scheduled_window_start: new Date('2026-10-20T13:00:00Z'),
        scheduled_window_end: new Date('2026-10-20T15:00:00Z'),
        delivery_date: '2026-10-20',
        contact_email: 'customer@example.test',
        has_contact_email: true,
        reschedule_attempts: 0,
        ...overrides,
    };
}

function setup(rows: unknown[], settings: Record<string, string> = {}) {
    const query = vi.fn(async () => rows);
    const values: Record<string, string> = {
        max_reschedule_attempts: '2',
        promise_response_window_minutes: '720',
        warehouse_prep_lead_minutes: '60',
        reschedule_code_expiry_minutes: '10',
        ...settings,
    };
    const getString = vi.fn(async (key: string, fallback: string) => values[key] ?? fallback);
    const getNumber = vi.fn(async (key: string, fallback: number) => {
        const parsed = Number(values[key]);
        return values[key] !== undefined && Number.isFinite(parsed) ? parsed : fallback;
    });
    const service = new PublicTrackingService({ query } as any, { getString, getNumber } as any);
    return { service, query };
}

describe('PublicTrackingService', () => {
    it('returns the minimum a customer may see, with what they can still do', async () => {
        const { service, query } = setup([row()]);

        const view = await service.view(TOKEN, NOW);

        expect(view).toEqual({
            trackingCode: 'TRK-000123',
            status: 'scheduled',
            customerConfirmation: 'pending',
            deliveryDate: '2026-10-20',
            windowStart: new Date('2026-10-20T13:00:00Z'),
            windowEnd: new Date('2026-10-20T15:00:00Z'),
            selfService: {
                open: true,
                closedReason: null,
                windowClosesAt: new Date('2026-10-18T02:00:00Z'),
                rescheduleAttemptsLeft: 2,
                canConfirm: true,
                canReschedule: true,
                canRequestChange: true,
            },
        });
        // The token is the only key of the lookup, and the expiry is checked against the same instant.
        expect(query).toHaveBeenCalledTimes(1);
        expect((query.mock.calls[0] as unknown[])[1]).toEqual([TOKEN, NOW]);
    });

    it('never exposes an identifier, an address, a phone or an OTP', async () => {
        const { service } = setup([row({ contact_phone: '+591 70000000', delivery_address: 'Calle 1', delivery_otp: '123456' })]);

        const serialized = JSON.stringify(await service.view(TOKEN, NOW));

        for (const secret of ['70000000', 'Calle 1', '123456', 'dispatch_id', 'dispatchId']) {
            expect(serialized).not.toContain(secret);
        }
    });

    it('answers the same 404 for an unknown token, a malformed one and an expired one, without reading for the malformed', async () => {
        const unknown = setup([]);
        await expect(unknown.service.view(TOKEN, NOW)).rejects.toBeInstanceOf(TrackingLinkNotFoundException);

        const malformed = setup([row()]);
        await expect(malformed.service.view('not a token!', NOW)).rejects.toBeInstanceOf(TrackingLinkNotFoundException);
        expect(malformed.query).not.toHaveBeenCalled();

        // Expiry is part of the WHERE clause: an expired token simply does not come back.
        const expired = setup([]);
        await expect(expired.service.view(TOKEN, NOW)).rejects.toMatchObject({
            response: { error: 'TRACKING_LINK_NOT_FOUND', message: 'Tracking link not found.' },
        });
    });

    it('counts only the reschedulings the customer made against the limit', async () => {
        const { service, query } = setup([row({ customer_confirmation: 'rescheduled', reschedule_attempts: 2 })]);

        const view = await service.view(TOKEN, NOW);

        expect(view.selfService).toMatchObject({ open: false, closedReason: 'max_attempts', rescheduleAttemptsLeft: 0 });
        expect(String((query.mock.calls[0] as unknown[])[0])).toContain("rescheduled_by_type = 'customer'");
    });

    it('does not offer rescheduling while the warehouse lead time is blank', async () => {
        const { service } = setup([row()], { warehouse_prep_lead_minutes: '' });

        expect((await service.view(TOKEN, NOW)).selfService).toMatchObject({ open: true, canConfirm: true, canReschedule: false });
    });

    it('does not offer rescheduling while the code validity is blank or not a number', async () => {
        for (const value of ['', 'abc', '0']) {
            const { service } = setup([row()], { reschedule_code_expiry_minutes: value });
            expect((await service.view(TOKEN, NOW)).selfService.canReschedule).toBe(false);
        }
    });

    it('uses the documented defaults when the settings are missing', async () => {
        const { service } = setup([row()], { max_reschedule_attempts: 'x', promise_response_window_minutes: 'x' });

        const { selfService } = await service.view(TOKEN, NOW);

        expect(selfService.rescheduleAttemptsLeft).toBe(2);
        expect(selfService.windowClosesAt).toEqual(new Date(NOTIFIED.getTime() + 720 * 60_000));
    });
});
