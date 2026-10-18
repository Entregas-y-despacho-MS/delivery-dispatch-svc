import { describe, expect, it, vi } from 'vitest';
import { RouteCapacityExceededException } from '../../../modules/dispatch/route-batches/exceptions/index.js';
import { localInstant } from '../../planning/domain/operating-calendar.js';
import type { SimStopResult } from '../../planning/domain/route-simulation.js';
import { buildSlotId, type RescheduleOffer } from '../domain/slot-offer.js';
import { CustomerRescheduleService } from './customer-reschedule.service.js';
import type { TrackingContext } from './public-tracking.service.js';

const NOW = new Date('2026-10-12T14:00:00Z');
const NOTIFIED = new Date('2026-10-12T13:00:00Z');
const CLOSES = new Date(NOTIFIED.getTime() + 720 * 60_000);
const TOKEN = '5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f';
const PROOF = 'a'.repeat(64);
const DATE = '2026-10-14';
const at = (time: string) => localInstant(DATE, time);
const FROM = 600;
const TO = 500;

const sim = (id: number, start: string, end: string): SimStopResult => ({
    id, arrivalMinute: 540, startMinute: 540, departureMinute: 555,
    window: { startMinute: Number(start.slice(0, 2)) * 60, endMinute: Number(end.slice(0, 2)) * 60 }, fixed: false,
});

const offer = (over: Partial<RescheduleOffer> = {}): RescheduleOffer => ({
    routeBatchId: TO, batchVersion: 3, deliveryDate: DATE, windowStart: at('09:00'), windowEnd: at('11:00'),
    costSeconds: 60, position: 1, route: [sim(20, '09:00', '11:00'), sim(1, '09:00', '11:00')], ...over,
});

function context(over: { attemptsUsed?: number; version?: number; fromBatchId?: number | null } = {}): TrackingContext {
    const used = over.attemptsUsed ?? 0;
    return {
        dispatchId: 1,
        status: 'scheduled',
        version: over.version ?? 1,
        row: {
            contact_email: 'customer@example.test', has_contact_email: true, route_batch_id: over.fromBatchId === undefined ? FROM : over.fromBatchId,
            reschedule_attempts: used, scheduled_window_start: at('13:00'), scheduled_window_end: at('15:00'),
        } as any,
        selfService: {
            open: true, closedReason: null, windowClosesAt: CLOSES, rescheduleAttemptsLeft: 2 - used,
            canConfirm: true, canReschedule: true, canRequestChange: true,
        },
    };
}

interface World {
    batches?: { id: number; status: string; version: number; vehicle_id: number | null }[];
    stops?: Record<string, unknown>[];
    used?: number;
}

const ownRow = (over: Record<string, unknown> = {}) => ({
    dispatch_id: 1, sequence_order: 1, version: 1, status: 'scheduled', customer_confirmation: 'pending', promise_firmed_at: null,
    route_batch_id: FROM, scheduled_window_start: at('13:00'), scheduled_window_end: at('15:00'), ...over,
});
const destinationStop = (over: Record<string, unknown> = {}) => ({
    dispatch_id: 20, sequence_order: 1, version: 4, status: 'scheduled', customer_confirmation: 'confirmed', promise_firmed_at: null,
    route_batch_id: TO, scheduled_window_start: at('09:00'), scheduled_window_end: at('11:00'), ...over,
});

function setup(options: {
    world?: World; proofIsValid?: boolean; offers?: RescheduleOffer[]; firm?: unknown; reissue?: unknown;
    capacityError?: Error; mailer?: () => Promise<unknown>; context?: TrackingContext;
} = {}) {
    const world: Required<World> = {
        batches: [{ id: TO, status: 'provisional', version: 3, vehicle_id: 9 }, { id: FROM, status: 'provisional', version: 7, vehicle_id: 8 }],
        stops: [ownRow(), destinationStop()],
        used: 0,
        ...options.world,
    };
    const sql: { sql: string; params: unknown[] }[] = [];
    const manager = {
        query: vi.fn(async (statement: string, params: unknown[] = []) => {
            sql.push({ sql: statement, params });
            if (statement.includes('FROM route_batches WHERE route_batch_id = ANY')) return [...world.batches].sort((a, b) => a.id - b.id);
            if (statement.includes('FROM dispatches d JOIN dispatch_statuses')) return world.stops;
            if (statement.includes('FROM dispatch_reschedules')) return [{ used: world.used }];
            if (statement.includes('INSERT INTO dispatch_reschedules')) return [{ dispatch_reschedule_id: 77 }];
            return [];
        }),
    };
    const dataSource = {
        transaction: vi.fn(async (work: (m: typeof manager) => Promise<unknown>) => await work(manager)),
        query: vi.fn(async () => []),
    };
    const ctx = options.context ?? context();
    const tracking = { resolve: vi.fn(async () => ctx), view: vi.fn(async () => ({ marker: 'view' })) };
    // The proof is claimed (null = not a valid proof) and, if the rescheduling does not happen, given back.
    const claim = { hash: 'h', expiresAt: NOW.getTime() + 10 * 60_000 };
    const verification = {
        claimProof: vi.fn(async () => (options.proofIsValid === false ? null : claim)),
        releaseProof: vi.fn(async () => undefined),
    };
    const offers = { computeOffers: vi.fn(async () => ({ offers: options.offers ?? [offer()], unavailableReason: null })) };
    const firming = {
        firm: vi.fn(async () => options.firm ?? { outcome: 'firmed', dispatchId: 1, recordVersion: 2, reason: 'customer_rescheduled' }),
        reissue: vi.fn(async () => options.reissue ?? { outcome: 'reissued', dispatchId: 1, recordVersion: 3 }),
    };
    const capacity = {
        assertAssignable: vi.fn(async () => { if (options.capacityError) throw options.capacityError; return {}; }),
    };
    const mailer = { send: vi.fn(options.mailer ?? (async () => ({ status: 'sent' }))) };
    const config = { get: vi.fn((_key: string, fallback: string) => fallback) };
    const service = new CustomerRescheduleService(
        dataSource as any, tracking as any, verification as any, offers as any, firming as any, capacity as any, mailer as any, config as any,
    );
    const choose = (chosen: RescheduleOffer = offer()) => buildSlotId(chosen.routeBatchId, chosen.windowStart);
    const statements = () => sql.map((entry) => entry.sql.replace(/\s+/g, ' ').trim());
    const indexOf = (fragment: string) => statements().findIndex((statement) => statement.includes(fragment));
    return { service, sql, statements, indexOf, manager, dataSource, tracking, verification, offers, firming, capacity, mailer, choose };
}

describe('CustomerRescheduleService', () => {
    describe('a valid rescheduling', () => {
        it('moves the dispatch, firms the promise, records the movement and answers the updated page', async () => {
            const { service, choose, firming, tracking } = setup();

            await expect(service.reschedule(TOKEN, choose(), PROOF, NOW)).resolves.toEqual({ marker: 'view' });

            expect(firming.firm).toHaveBeenCalledWith(1, expect.objectContaining({ reason: 'customer_rescheduled', now: NOW, manager: expect.anything() }));
            expect(firming.reissue).not.toHaveBeenCalled();
            expect(tracking.view).toHaveBeenCalledWith(TOKEN, NOW);
        });

        it('locks both batches in id order before any dispatch, whichever the direction of the move', async () => {
            const { service, choose, sql, indexOf } = setup();

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            expect(indexOf('FROM route_batches WHERE route_batch_id = ANY')).toBe(0);
            expect(indexOf('FROM dispatches d JOIN dispatch_statuses')).toBe(1);
            expect(sql[0].params).toEqual([[FROM, TO]]);
            expect(sql[1].sql).toContain('ORDER BY d.dispatch_id FOR UPDATE OF d');
        });

        it('enters the new batch first and leaves the old one afterwards', async () => {
            const { service, choose, statements } = setup({ world: { stops: [ownRow(), ownRow({ dispatch_id: 2, sequence_order: 2, customer_confirmation: 'confirmed' }), destinationStop()] } });

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            const text = statements();
            const entered = text.findIndex((s) => s.includes('SET route_batch_id = $2'));
            const parkedDestination = text.findIndex((s) => s.includes('sequence_order = NULL'));
            const leftOrigin = text.findIndex((s, i) => i > entered && s.includes('sequence_order = NULL'));
            expect(parkedDestination).toBeGreaterThan(-1);
            expect(parkedDestination).toBeLessThan(entered);
            expect(leftOrigin).toBeGreaterThan(entered);
        });

        it('raises the dispatch version in the move and the version of both batches', async () => {
            const { service, choose, sql } = setup({ world: { stops: [ownRow(), ownRow({ dispatch_id: 2, sequence_order: 2, customer_confirmation: 'confirmed' }), destinationStop()] } });

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            const move = sql.find((entry) => entry.sql.includes('SET route_batch_id = $2'))!;
            expect(move.sql).toMatch(/version = version \+ 1/);
            expect(move.params).toEqual([1, TO, 2, at('09:00'), at('11:00')]);
            const batchBumps = sql.filter((entry) => /UPDATE route_batches SET version = version \+ 1/.test(entry.sql.replace(/\s+/g, ' ')));
            expect(batchBumps.map((entry) => entry.params[0]).sort()).toEqual([TO, FROM].sort());
        });

        it('closes the gap in the old batch and bumps the version of the dispatches that changed place', async () => {
            const { service, choose, sql } = setup({
                world: { stops: [ownRow({ sequence_order: 1 }), ownRow({ dispatch_id: 2, sequence_order: 2, customer_confirmation: 'confirmed' }), destinationStop()] },
            });

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            const closing = sql.find((entry) => entry.sql.includes('unnest($1::int[]) AS id, unnest($2::int[]) AS seq, unnest($3::boolean[]) AS bump'))!;
            expect(closing.params).toEqual([[2], [1], [true]]);
        });

        it('never touches promise_notified_at: the 12 hours do not start again', async () => {
            const { service, choose, statements } = setup();

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            expect(statements().filter((s) => s.startsWith('UPDATE')).join(' ')).not.toContain('promise_notified_at');
        });

        it('writes the customer rescheduling with the previous and the new batch and window', async () => {
            const { service, choose, sql } = setup();

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            const row = sql.find((entry) => entry.sql.includes('INSERT INTO dispatch_reschedules'))!;
            expect(row.sql).toContain("'customer'");
            expect(row.params).toEqual([1, 'RES-CLI-SELF', FROM, TO, at('13:00'), at('15:00'), at('09:00'), at('11:00')]);
        });

        it('writes one batch event of the movement on the destination, linked to the rescheduling and without the token', async () => {
            const { service, choose, sql } = setup({ world: { stops: [ownRow(), ownRow({ dispatch_id: 2, sequence_order: 2, customer_confirmation: 'confirmed' }), destinationStop()] } });

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            const events = sql.filter((entry) => entry.sql.includes('INSERT INTO route_batch_events'));
            expect(events).toHaveLength(1);
            expect(events[0].sql).toContain("'customer_rescheduled'");
            expect(events[0].params[0]).toBe(TO);
            expect(events[0].params[1]).toBe(1);
            const metadata = JSON.parse(events[0].params[2] as string);
            expect(metadata).toMatchObject({
                rescheduleId: 77, fromBatchId: FROM, toBatchId: TO, recordVersion: 2, newSequence: 2, previousSequence: 1,
                fromBatchCancelled: false, promiseFirmedByThisRescheduling: true,
            });
            expect(JSON.stringify(sql.map((entry) => entry.params))).not.toContain(TOKEN);
        });

        it('leaves the customer as rescheduled once the promise is firm', async () => {
            const { service, choose, statements, firming } = setup();

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            const confirmation = statements().findIndex((s) => s.includes("customer_confirmation = 'rescheduled'"));
            expect(confirmation).toBeGreaterThan(-1);
            expect(firming.firm.mock.invocationCallOrder[0]).toBeLessThan(firming.reissue.mock.invocationCallOrder[0] ?? Infinity);
        });

        it('replaces the preparation order of a promise that is already firm instead of firming it again', async () => {
            const { service, choose, firming } = setup({
                world: { stops: [ownRow({ promise_firmed_at: new Date('2026-10-12T13:30:00Z'), customer_confirmation: 'rescheduled' }), destinationStop()], used: 1 },
                context: context({ attemptsUsed: 1 }),
            });

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            expect(firming.reissue).toHaveBeenCalledWith(1, expect.objectContaining({ now: NOW, manager: expect.anything() }));
            expect(firming.firm).not.toHaveBeenCalled();
        });

        it('asks the routing engine before it opens the transaction', async () => {
            const { service, choose, offers, dataSource } = setup();

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            expect(offers.computeOffers.mock.invocationCallOrder[0]).toBeLessThan(dataSource.transaction.mock.invocationCallOrder[0]);
        });

        it('keeps the proof spent once it happened (it is not given back), and the email carries the new slot', async () => {
            const { service, choose, verification, mailer } = setup();

            await service.reschedule(TOKEN, choose(), PROOF, NOW);

            expect(verification.claimProof).toHaveBeenCalledWith(1, PROOF, NOW);
            expect(verification.releaseProof).not.toHaveBeenCalled();
            expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({
                to: 'customer@example.test', template: 'promise',
                context: expect.objectContaining({ trackingUrl: `http://localhost:5173/seguimiento/${TOKEN}` }),
            }));
        });

        it('keeps the batch alive when other customers stay in it, and cancels it when it is left empty', async () => {
            const alone = setup();
            const shared = setup({ world: { stops: [ownRow(), ownRow({ dispatch_id: 2, sequence_order: 2, customer_confirmation: 'confirmed' }), destinationStop()] } });

            await alone.service.reschedule(TOKEN, alone.choose(), PROOF, NOW);
            await shared.service.reschedule(TOKEN, shared.choose(), PROOF, NOW);

            expect(alone.statements().some((s) => s.includes("SET status = 'cancelled'"))).toBe(true);
            expect(alone.sql.filter((e) => e.sql.includes("'cancelled'") && e.sql.includes('INSERT INTO route_batch_events'))).toHaveLength(1);
            expect(shared.statements().some((s) => s.includes("SET status = 'cancelled'"))).toBe(false);
        });
    });

    describe('what stops it before anything is written', () => {
        it('needs the proof, and checks it before it looks at the plan', async () => {
            const { service, choose, offers, dataSource } = setup({ proofIsValid: false });

            await expect(service.reschedule(TOKEN, choose(), PROOF, NOW)).rejects.toMatchObject({ status: 403, response: { error: 'VERIFICATION_REQUIRED' } });
            expect(offers.computeOffers).not.toHaveBeenCalled();
            expect(dataSource.transaction).not.toHaveBeenCalled();
        });

        it.each(['', 'abc', '5', '5.', '.5', '5.6.7', '5.1e9', '-5.100'])('is a SLOT_NO_LONGER_AVAILABLE for the id %j', async (slotId) => {
            const { service, offers, verification } = setup();

            await expect(service.reschedule(TOKEN, slotId, PROOF, NOW)).rejects.toMatchObject({ status: 409, response: { error: 'SLOT_NO_LONGER_AVAILABLE' } });
            expect(offers.computeOffers).not.toHaveBeenCalled();
            // A request that cannot be a rescheduling does not even touch the proof.
            expect(verification.claimProof).not.toHaveBeenCalled();
        });

        it('is a SLOT_NO_LONGER_AVAILABLE when the plan does not offer that time any more', async () => {
            const { service, dataSource, firming, verification } = setup({ offers: [] });

            await expect(service.reschedule(TOKEN, buildSlotId(TO, at('09:00')), PROOF, NOW))
                .rejects.toMatchObject({ response: { error: 'SLOT_NO_LONGER_AVAILABLE' } });
            expect(dataSource.transaction).not.toHaveBeenCalled();
            expect(firming.firm).not.toHaveBeenCalled();
            expect(verification.releaseProof).toHaveBeenCalledTimes(1);
        });

        it('takes the slot by its date and time even if another batch offers it now', async () => {
            const { service, sql } = setup({ offers: [offer({ routeBatchId: TO })] });

            await service.reschedule(TOKEN, buildSlotId(999, at('09:00')), PROOF, NOW);

            expect(sql.find((entry) => entry.sql.includes('SET route_batch_id = $2'))!.params[1]).toBe(TO);
        });
    });

    describe('what is checked again under the lock, and leaves everything as it was', () => {
        const fails = async (options: Parameters<typeof setup>[0], error: Record<string, unknown>) => {
            const run = setup(options);
            await expect(run.service.reschedule(TOKEN, run.choose(), PROOF, NOW)).rejects.toMatchObject(error);
            // Nothing changed, so the customer gets the proof back.
            expect(run.verification.releaseProof).toHaveBeenCalledTimes(1);
            expect(run.mailer.send).not.toHaveBeenCalled();
            expect(run.tracking.view).not.toHaveBeenCalled();
            return run;
        };

        it('the destination batch changed since the offer', async () => {
            const run = await fails({ world: { batches: [{ id: TO, status: 'provisional', version: 4, vehicle_id: 9 }, { id: FROM, status: 'provisional', version: 7, vehicle_id: 8 }] } }, { response: { error: 'SLOT_NO_LONGER_AVAILABLE' } });
            expect(run.firming.firm).not.toHaveBeenCalled();
            expect(run.statements().some((s) => s.startsWith('UPDATE'))).toBe(false);
        });

        it('the destination batch is no longer open', async () => {
            await fails({ world: { batches: [{ id: TO, status: 'pending_final_review', version: 3, vehicle_id: 9 }, { id: FROM, status: 'provisional', version: 7, vehicle_id: 8 }] } }, { response: { error: 'SLOT_NO_LONGER_AVAILABLE' } });
        });

        it('the origin batch is no longer open', async () => {
            await fails({ world: { batches: [{ id: TO, status: 'provisional', version: 3, vehicle_id: 9 }, { id: FROM, status: 'pending_final_review', version: 7, vehicle_id: 8 }] } }, { status: 409, response: { error: 'RESCHEDULE_NOT_AVAILABLE', details: { reason: 'batch_not_open' } } });
        });

        it('the destination holds other stops than the ones the route was simulated with', async () => {
            const run = await fails({ world: { stops: [ownRow(), destinationStop(), destinationStop({ dispatch_id: 21, sequence_order: 2 })] } }, { response: { error: 'SLOT_NO_LONGER_AVAILABLE' } });
            expect(run.statements().some((s) => s.startsWith('UPDATE'))).toBe(false);
        });

        it('the dispatch changed version while the customer was choosing', async () => {
            await fails({ world: { stops: [ownRow({ version: 2 }), destinationStop()] } }, { response: { error: 'SLOT_NO_LONGER_AVAILABLE' } });
        });

        it('the dispatch is not in the batch the page showed', async () => {
            await fails({ world: { stops: [ownRow({ route_batch_id: 123 }), destinationStop()] } }, { response: { error: 'SLOT_NO_LONGER_AVAILABLE' } });
        });

        it('the customer answered in the meantime', async () => {
            await fails({ world: { stops: [ownRow({ customer_confirmation: 'confirmed' }), destinationStop()] } }, { response: { details: { reason: 'not_open' } } });
            await fails({ world: { stops: [ownRow({ customer_confirmation: 'change_requested' }), destinationStop()] } }, { response: { details: { reason: 'not_open' } } });
        });

        it('the dispatch moved on in its life', async () => {
            await fails({ world: { stops: [ownRow({ status: 'assigned' }), destinationStop()] } }, { response: { details: { reason: 'not_open' } } });
        });

        it('the attempts were used up by a parallel request', async () => {
            await fails({ world: { used: 2 } }, { response: { details: { reason: 'max_attempts' } } });
        });

        it('the original window ended meanwhile', async () => {
            const run = setup();
            const late = new Date(CLOSES.getTime());

            await expect(run.service.reschedule(TOKEN, run.choose(), PROOF, late)).rejects.toMatchObject({ response: { details: { reason: 'window_elapsed' } } });
            expect(run.firming.firm).not.toHaveBeenCalled();
        });

        it('the vehicle can no longer hold the load', async () => {
            const run = await fails({ capacityError: new RouteCapacityExceededException({ assignable: false } as any) }, { response: { error: 'SLOT_NO_LONGER_AVAILABLE' } });
            expect(run.capacity.assertAssignable).toHaveBeenCalledWith(TO, 9, expect.anything());
        });

        it('the promise cannot be firmed because the order is incomplete', async () => {
            await fails({ firm: { outcome: 'incomplete', dispatchId: 1, cause: 'missing_packages' } }, { response: { details: { reason: 'order_incomplete' } } });
        });

        it('the promise is not eligible any more', async () => {
            await fails({ firm: { outcome: 'not_eligible', dispatchId: 1, cause: 'status' } }, { response: { details: { reason: 'promise_not_firm' } } });
        });

        it('a replacement order with a version that did not grow is refused', async () => {
            await fails({
                world: { stops: [ownRow({ promise_firmed_at: new Date(), customer_confirmation: 'rescheduled' }), destinationStop()], used: 1 },
                context: context({ attemptsUsed: 1 }),
                reissue: { outcome: 'not_eligible', dispatchId: 1, cause: 'version_not_increased' },
            }, { response: { details: { reason: 'promise_not_firm' } } });
        });

        it('the dispatch has no route', async () => {
            await fails({ context: context({ fromBatchId: null }) }, { response: { details: { reason: 'no_route' } } });
        });
    });

    describe('after it happened', () => {
        it('is not undone by an email that cannot be sent, and does not log the address', async () => {
            const { service, choose, tracking } = setup({ mailer: async () => { throw new Error('smtp down'); } });

            await expect(service.reschedule(TOKEN, choose(), PROOF, NOW)).resolves.toEqual({ marker: 'view' });
            expect(tracking.view).toHaveBeenCalled();
        });

        it('records that the confirmation email was sent only when the transport accepted it', async () => {
            const accepted = setup();
            const bounced = setup({ mailer: async () => ({ status: 'bounced' }) });

            await accepted.service.reschedule(TOKEN, accepted.choose(), PROOF, NOW);
            await bounced.service.reschedule(TOKEN, bounced.choose(), PROOF, NOW);

            expect(accepted.dataSource.query).toHaveBeenCalledTimes(1);
            expect(String(accepted.dataSource.query.mock.calls[0][0])).toContain('reschedule_confirmation_sent');
            expect(bounced.dataSource.query).not.toHaveBeenCalled();
        });
    });
});
