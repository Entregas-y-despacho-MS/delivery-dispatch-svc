import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OutboxService } from '../../../modules/messaging/outbound-messages/services/outbox.service.js';
import { MessageValidator } from '../../../plugins/messaging/envelope/message-validator.js';
import { PromiseFirmingService } from './promise-firming.service.js';
import { PromiseWindowCloseService } from './promise-window-close.service.js';

const validator = MessageValidator.fromDirectory(resolve(process.cwd(), 'contracts/messages'));
const MIN = 60_000;
const T0 = new Date('2026-10-15T12:00:00.000Z'); // first valid notice
const at = (minutesAfterNotice: number) => new Date(T0.getTime() + minutesAfterNotice * MIN);

interface World {
    id: number;
    status: string;
    version: number;
    notifiedAt: Date | null;
    firmedAt: Date | null;
    confirmation: string;
    packages: number;
}

/**
 * A tiny in-memory "database" behind the real PromiseFirmingService and the real close service, so the
 * simulated clock goes through the same decisions as production. The candidate filter mirrors the SQL of
 * PromiseWindowCandidatesRepository (that SQL itself is exercised by the e2e).
 */
function build(worlds: World[], windowMinutes = 720) {
    const byId = new Map(worlds.map((w) => [w.id, w]));
    const events: { id: number; type: string; actor: string; metadata: any }[] = [];
    const queued: any[] = [];

    const manager = {
        query: vi.fn(async (sql: string, params: any[]) => {
            const w = byId.get(params[0]);
            if (sql.includes('FROM dispatches d')) {
                if (!w) return [];
                return [{
                    id: w.id, status: w.status, version: w.version, source_order_ref: `SO-${w.id}`, tracking_code: `DSP-2026-${String(w.id).padStart(5, '0')}`,
                    promise_notified_at: w.notifiedAt, promise_firmed_at: w.firmedAt, customer_confirmation: w.confirmation,
                    scheduled_window_start: new Date('2026-10-17T14:00:00.000Z'), scheduled_window_end: new Date('2026-10-17T16:00:00.000Z'),
                    departure_date: '2026-10-17', warehouse_code: 'WH-LPZ-01',
                }];
            }
            if (sql.includes('FROM dispatch_packages')) {
                return Array.from({ length: w!.packages }, (_, i) => ({
                    external_package_id: `PKG-${w!.id}-${i + 1}`, length_cm: '40', width_cm: '30', height_cm: '25', gross_weight_kg: '6.4',
                }));
            }
            if (sql.includes('FROM dispatch_events')) {
                const sent = events.filter((e) => e.id === params[0] && ['promise_firmed', 'preparation_order_reissued'].includes(e.type));
                return [{ last_version: Math.max(0, ...sent.map((e) => e.metadata.recordVersion)) }];
            }
            if (sql.includes('UPDATE dispatches')) {
                if (!w || w.firmedAt) return [];
                w.firmedAt = params[1];
                w.confirmation = 'confirmed';
                return [{ dispatch_id: w.id }];
            }
            if (sql.includes('INSERT INTO dispatch_events')) {
                const type = /'(promise_firmed|preparation_order_reissued)'/.exec(sql)![1];
                events.push({ id: params[0], type, actor: type === 'promise_firmed' ? params[1] : 'customer', metadata: JSON.parse(params[params.length - 1]) });
                return [];
            }
            return [];
        }),
    };
    const dataSource = { transaction: vi.fn((work: (m: any) => Promise<any>) => work(manager)) };
    const outbox = new OutboxService({ manager: { query: vi.fn() } } as never, validator);
    vi.spyOn(outbox, 'enqueue').mockImplementation(async (envelope) => {
        const result = validator.validate(envelope.type, envelope);
        if (!result.valid) throw new Error(`invalid message: ${JSON.stringify(result.errors)}`);
        queued.push(envelope);
        return true;
    });
    const settings = { getNumber: vi.fn().mockResolvedValue(windowMinutes) };
    const firming = new PromiseFirmingService(dataSource as never, outbox, settings as never);
    const candidates = {
        findClosable: vi.fn(async (now: Date, minutes: number) =>
            worlds.filter((w) =>
                ['scheduled', 'assigned'].includes(w.status) && w.notifiedAt && !w.firmedAt && w.confirmation === 'pending'
                && w.notifiedAt.getTime() + minutes * MIN <= now.getTime()).map((w) => w.id)),
    };
    const close = new PromiseWindowCloseService(candidates as never, firming, settings as never);
    return { close, firming, queued, events, candidates, byId };
}

const world = (over: Partial<World> = {}): World => ({
    id: 1, status: 'scheduled', version: 2, notifiedAt: T0, firmedAt: null, confirmation: 'pending', packages: 1, ...over,
});

describe('PromiseWindowCloseService with a simulated clock', () => {
    it('does nothing one minute before the 12 h elapse, firms at the exact minute, and never twice', async () => {
        const { close, queued, byId } = build([world()]);

        expect(await close.run(at(719))).toMatchObject({ candidates: 0, firmed: 0 });
        expect(queued).toHaveLength(0);

        expect(await close.run(at(720))).toEqual({ candidates: 1, firmed: 1, skipped: 0, incomplete: 0, failed: 0 });
        expect(queued).toHaveLength(1);
        expect(queued[0].data).toMatchObject({ salesOrderId: 'SO-1', recordVersion: 2, departureDate: '2026-10-17' });
        expect(byId.get(1)).toMatchObject({ confirmation: 'confirmed', firmedAt: at(720) });

        // The next ticks (and a re-run of the same occurrence) find nothing to do.
        expect(await close.run(at(725))).toMatchObject({ candidates: 0 });
        expect(await close.run(at(720))).toMatchObject({ candidates: 0 });
        expect(queued).toHaveLength(1);
    });

    it('firms silence with a valid notice but never a bounced notice (no promise_notified_at)', async () => {
        const { close, queued, byId } = build([world({ id: 1 }), world({ id: 2, notifiedAt: null })]);

        const summary = await close.run(at(24 * 60));

        expect(summary).toMatchObject({ candidates: 1, firmed: 1 });
        expect(queued.map((m) => m.data.salesOrderId)).toEqual(['SO-1']);
        expect(byId.get(2)).toMatchObject({ firmedAt: null, confirmation: 'pending' });
    });

    it('does not fire a second order when the customer confirmed before the window closed', async () => {
        const { close, firming, queued, events } = build([world()]);

        const confirmed = await firming.firm(1, { reason: 'customer_confirmed', now: at(60) });
        expect(confirmed).toMatchObject({ outcome: 'firmed', reason: 'customer_confirmed' });
        expect(queued).toHaveLength(1);

        expect(await close.run(at(720))).toMatchObject({ candidates: 0, firmed: 0 });
        expect(queued).toHaveLength(1);
        expect(events.filter((e) => e.type === 'promise_firmed')).toHaveLength(1);
    });

    it('keeps the clock from the first notice: a later reprogramming does not extend or restart the window', async () => {
        // The customer rescheduled at +60 min (D-47): promise firm, version bumped, notified_at untouched.
        const { close, firming, queued, byId } = build([world({ version: 2 })]);
        await firming.firm(1, { reason: 'customer_confirmed', now: at(30) });
        byId.get(1)!.version = 3;
        const reissued = await firming.reissue(1, { now: at(60) });

        expect(reissued).toEqual({ outcome: 'reissued', dispatchId: 1, recordVersion: 3 });
        expect(queued.map((m) => m.data.recordVersion)).toEqual([2, 3]);
        expect(byId.get(1)!.notifiedAt).toEqual(T0);
        // Already firm: the window closing at +720 finds nothing and emits nothing more.
        expect(await close.run(at(720))).toMatchObject({ candidates: 0 });
        expect(queued).toHaveLength(2);
    });

    it('replays a reissue only with a strictly higher version', async () => {
        const { firming, queued, byId } = build([world({ version: 2 })]);
        await firming.firm(1, { reason: 'window_elapsed', now: at(720) });

        expect(await firming.reissue(1, { now: at(730) })).toMatchObject({ outcome: 'not_eligible', cause: 'version_not_increased' });
        byId.get(1)!.version = 4;
        expect(await firming.reissue(1, { now: at(740) })).toMatchObject({ outcome: 'reissued', recordVersion: 4 });
        expect(await firming.reissue(1, { now: at(750) })).toMatchObject({ outcome: 'not_eligible', cause: 'version_not_increased' });
        expect(queued.map((m) => m.data.recordVersion)).toEqual([2, 4]);
    });

    it('leaves change_requested and states without a promise alone', async () => {
        const { close, queued } = build([
            world({ id: 1, confirmation: 'change_requested' }),
            world({ id: 2, status: 'cancelled' }),
        ]);

        expect(await close.run(at(24 * 60))).toMatchObject({ candidates: 0, firmed: 0 });
        expect(queued).toHaveLength(0);
    });

    it('counts an incomplete dispatch without firming it and keeps going with the rest', async () => {
        const { close, queued, byId } = build([world({ id: 1, packages: 0 }), world({ id: 2 })]);

        const summary = await close.run(at(720));

        expect(summary).toEqual({ candidates: 2, firmed: 1, skipped: 0, incomplete: 1, failed: 0 });
        expect(byId.get(1)!.firmedAt).toBeNull();
        expect(queued.map((m) => m.data.salesOrderId)).toEqual(['SO-2']);
    });

    it('honours a changed window setting on the next run', async () => {
        const { close, queued } = build([world()], 60);

        expect(await close.run(at(59))).toMatchObject({ candidates: 0 });
        expect(await close.run(at(60))).toMatchObject({ firmed: 1 });
        expect(queued).toHaveLength(1);
    });

    it('processes every dispatch before failing the run when one throws', async () => {
        const { close, firming, queued } = build([world({ id: 1 }), world({ id: 2 })]);
        const original = firming.firm.bind(firming);
        vi.spyOn(firming, 'firm').mockImplementation(async (id, options) => {
            if (id === 1) throw new Error('boom');
            return await original(id, options);
        });

        await expect(close.run(at(720))).rejects.toThrow('1 of 2 dispatches failed');
        expect(queued.map((m) => m.data.salesOrderId)).toEqual(['SO-2']);
    });
});
