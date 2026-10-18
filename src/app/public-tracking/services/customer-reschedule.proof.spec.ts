// The proof of the verification code is good for ONE rescheduling, also when requests come at the same time (review of
// ST-224.1, PR #51). These tests use the REAL VerificationCodeService over the in-memory cache, so the claim is the
// real one; the plan, the transaction and the mail are doubles. What is under test is what happens to the proof.
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { MemoryCacheAdapter } from '../../../plugins/cache/memory/memory-cache.adapter.js';
import { localInstant } from '../../planning/domain/operating-calendar.js';
import { buildSlotId, type RescheduleOffer } from '../domain/slot-offer.js';
import { CustomerRescheduleService } from './customer-reschedule.service.js';
import type { TrackingContext } from './public-tracking.service.js';
import { VerificationCodeService } from './verification-code.service.js';

const MIN = 60_000;
const NOW = new Date('2026-10-12T14:00:00Z');
const TOKEN = '5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f';
const DATE = '2026-10-14';
const OFFER: RescheduleOffer = {
    routeBatchId: 500, batchVersion: 3, deliveryDate: DATE, windowStart: localInstant(DATE, '09:00'), windowEnd: localInstant(DATE, '11:00'),
    costSeconds: 60, position: 0, route: [],
};
const SLOT = buildSlotId(OFFER.routeBatchId, OFFER.windowStart);

const context: TrackingContext = {
    dispatchId: 1,
    status: 'scheduled',
    version: 1,
    row: { contact_email: 'customer@example.test', has_contact_email: true, route_batch_id: 600, reschedule_attempts: 0 } as any,
    selfService: {
        open: true, closedReason: null, windowClosesAt: new Date(NOW.getTime() + 600 * MIN), rescheduleAttemptsLeft: 2,
        canConfirm: true, canReschedule: true, canRequestChange: true,
    },
};

function setup(options: { cache?: MemoryCacheAdapter; transaction?: () => Promise<unknown>; computeOffers?: () => Promise<unknown> } = {}) {
    const cache = options.cache ?? new MemoryCacheAdapter();
    const codes: string[] = [];
    const mailer = { send: vi.fn(async (mail: any) => { if (mail.template === 'reschedule-code') codes.push(mail.context.code); return { status: 'sent' }; }) };
    const settings = { getNumber: vi.fn(async () => 10) };
    const verification = new VerificationCodeService({ query: vi.fn(async () => []) } as any, cache, mailer as any, settings as any);
    const applied = { fromBatchId: 600, rescheduleId: 1, recordVersion: 2, originCancelled: false };
    const dataSource = { transaction: vi.fn(options.transaction ?? (async () => applied)), query: vi.fn(async () => []) };
    const tracking = { resolve: vi.fn(async () => context), view: vi.fn(async () => ({ marker: 'view' })) };
    const offers = { computeOffers: vi.fn(options.computeOffers ?? (async () => ({ offers: [OFFER], unavailableReason: null }))) };
    const service = new CustomerRescheduleService(
        dataSource as any, tracking as any, verification, offers as any, {} as any, {} as any, mailer as any, { get: (_k: string, f: string) => f } as any,
    );
    /** A proof issued the real way: a code is sent and checked. */
    const issueProof = async (): Promise<string> => {
        await verification.send(context, NOW);
        return (await verification.verify(context, codes.at(-1)!, NOW)).proof;
    };
    return { service, verification, cache, dataSource, offers, tracking, mailer, issueProof };
}

describe('the proof of a rescheduling is claimed atomically', () => {
    afterEach(() => vi.restoreAllMocks());

    it('lets only one of several simultaneous requests with the same proof reach the plan and the transaction', async () => {
        const { service, issueProof, dataSource, offers } = setup();
        const proof = await issueProof();

        const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.reschedule(TOKEN, SLOT, proof, NOW)));

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const refused of results.filter((r) => r.status === 'rejected')) {
            expect((refused as PromiseRejectedResult).reason).toMatchObject({ status: 403, response: { error: 'VERIFICATION_REQUIRED' } });
        }
        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(offers.computeOffers).toHaveBeenCalledTimes(1);
    });

    it('claims the proof before asking the routing engine and before opening the transaction', async () => {
        const { service, issueProof, dataSource, offers, verification } = setup();
        const proof = await issueProof();
        const claim = vi.spyOn(verification, 'claimProof');

        await service.reschedule(TOKEN, SLOT, proof, NOW);

        expect(claim.mock.invocationCallOrder[0]).toBeLessThan(offers.computeOffers.mock.invocationCallOrder[0]);
        expect(claim.mock.invocationCallOrder[0]).toBeLessThan(dataSource.transaction.mock.invocationCallOrder[0]);
    });

    it('spends it for good once the rescheduling happened: the same proof gives nothing a second time', async () => {
        const { service, issueProof, dataSource, verification } = setup();
        const proof = await issueProof();
        await service.reschedule(TOKEN, SLOT, proof, NOW);

        await expect(service.reschedule(TOKEN, SLOT, proof, NOW)).rejects.toMatchObject({ status: 403, response: { error: 'VERIFICATION_REQUIRED' } });

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        await expect(verification.hasValidProof(1, proof, NOW)).resolves.toBe(false);
    });

    describe('when it fails after the proof was claimed, nothing changed and the customer keeps the proof', () => {
        const failures: [string, Parameters<typeof setup>[0]][] = [
            ['the plan no longer offers that time', { computeOffers: async () => ({ offers: [], unavailableReason: 'no_slots' }) }],
            ['the routing engine is down', { computeOffers: async () => { throw new OsrmUnavailableException(); } }],
            ['the transaction is refused', { transaction: async () => { throw new Error('serialization failure'); } }],
        ];

        it.each(failures)('%s', async (_name, options) => {
            const { service, issueProof, verification } = setup(options);
            const proof = await issueProof();

            await expect(service.reschedule(TOKEN, SLOT, proof, NOW)).rejects.toBeDefined();

            await expect(verification.hasValidProof(1, proof, NOW)).resolves.toBe(true);
        });

        it('and can use it again for another choice', async () => {
            let attempts = 0;
            const { service, issueProof, dataSource } = setup({ transaction: async () => {
                if (++attempts === 1) throw new Error('serialization failure');
                return { fromBatchId: 600, rescheduleId: 1, recordVersion: 2, originCancelled: false };
            } });
            const proof = await issueProof();
            await expect(service.reschedule(TOKEN, SLOT, proof, NOW)).rejects.toBeDefined();

            await expect(service.reschedule(TOKEN, SLOT, proof, NOW)).resolves.toEqual({ marker: 'view' });

            expect(dataSource.transaction).toHaveBeenCalledTimes(2);
        });

        it('gives back only what is left of its life: an expired proof is not brought back to life', async () => {
            vi.useFakeTimers();
            try {
                const { service, issueProof, verification } = setup({ computeOffers: async () => {
                    // The plan takes longer than the whole life of the proof.
                    vi.advanceTimersByTime(11 * MIN);
                    return { offers: [], unavailableReason: 'no_slots' };
                } });
                vi.setSystemTime(NOW);
                const proof = await issueProof();

                await expect(service.reschedule(TOKEN, SLOT, proof, new Date(NOW.getTime()))).rejects.toBeDefined();

                await expect(verification.hasValidProof(1, proof, new Date(NOW.getTime() + 11 * MIN))).resolves.toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not hide the real failure when the proof cannot be given back, and does not log the token', async () => {
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const { service, issueProof, cache } = setup({ computeOffers: async () => { throw new OsrmUnavailableException(); } });
            const proof = await issueProof();
            vi.spyOn(cache, 'setIfAbsent').mockRejectedValue(new CacheUnavailableException());

            await expect(service.reschedule(TOKEN, SLOT, proof, NOW)).rejects.toBeInstanceOf(OsrmUnavailableException);

            const lines = warn.mock.calls.map((call) => String(call[0]));
            expect(lines.some((line) => line.includes('could not be given back'))).toBe(true);
            expect(lines.join(' ')).not.toContain(TOKEN);
            expect(lines.join(' ')).not.toContain(proof);
        });

        it('does not bring back a proof the customer replaced by a newer one meanwhile', async () => {
            const { service, issueProof, verification } = setup({ computeOffers: async () => ({ offers: [], unavailableReason: 'no_slots' }) });
            const old = await issueProof();
            const reschedule = service.reschedule(TOKEN, SLOT, old, NOW);
            await expect(reschedule).rejects.toBeDefined();
            const fresh = await issueProof();

            await expect(verification.hasValidProof(1, fresh, NOW)).resolves.toBe(true);
            await expect(verification.hasValidProof(1, old, NOW)).resolves.toBe(false);
        });
    });

    it('does not spend the proof on a request that cannot be a rescheduling (malformed slot id)', async () => {
        const { service, issueProof, verification } = setup();
        const proof = await issueProof();

        await expect(service.reschedule(TOKEN, 'not-a-slot', proof, NOW)).rejects.toMatchObject({ response: { error: 'SLOT_NO_LONGER_AVAILABLE' } });

        await expect(verification.hasValidProof(1, proof, NOW)).resolves.toBe(true);
    });

    it('refuses with 503 and does nothing else when the store of proofs is down', async () => {
        const { service, issueProof, cache, dataSource, offers } = setup();
        const proof = await issueProof();
        vi.spyOn(cache, 'get').mockRejectedValue(new CacheUnavailableException());

        await expect(service.reschedule(TOKEN, SLOT, proof, NOW)).rejects.toMatchObject({ status: 503, response: { error: 'VERIFICATION_UNAVAILABLE' } });

        expect(offers.computeOffers).not.toHaveBeenCalled();
        expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses a wrong or missing proof without touching the real one', async () => {
        const { service, issueProof, verification } = setup();
        const proof = await issueProof();

        for (const wrong of [undefined, '', 'nope', 'b'.repeat(64)]) {
            await expect(service.reschedule(TOKEN, SLOT, wrong, NOW)).rejects.toMatchObject({ status: 403 });
        }

        await expect(verification.hasValidProof(1, proof, NOW)).resolves.toBe(true);
    });
});
