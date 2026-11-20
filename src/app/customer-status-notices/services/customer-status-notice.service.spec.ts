import { describe, expect, it, vi } from 'vitest';
import type { DispatchStatusChangedEvent } from '../../dispatch-status/dispatch-status-changed.event.js';
import type { StatusNoticeDispatch } from '../domain/build-status-notice.js';
import { CustomerStatusNoticeService } from './customer-status-notice.service.js';

const NOW = new Date('2026-11-19T16:00:00.000Z');
const event = (over: Partial<DispatchStatusChangedEvent> = {}): DispatchStatusChangedEvent => ({
    dispatchId: 7, status: 'delivered', previousStatus: 'in_transit', version: 3, updatedAt: '2026-11-19T14:30:00.000Z', ...over,
});
const dispatch = (over: Partial<StatusNoticeDispatch> = {}): StatusNoticeDispatch => ({
    dispatchId: 7, type: 'delivery', currentStatus: 'in_transit', contactEmail: 'ana@example.com', trackingCode: 'DSP-2026-00007',
    trackingToken: 'secret-token', trackingTokenExpiresAt: null, ...over,
});

type MailStep = 'sent' | 'bounced' | 'failed' | 'throw';
interface Options {
    dispatch?: StatusNoticeDispatch | null;
    /** The id `reserve` returns; `null` is a key that was already taken. */
    reserved?: number | null;
    /** What each attempt with the provider does, in order; the last one repeats. */
    mail?: MailStep[];
    recordThrows?: boolean;
    superseded?: boolean;
}

function build(options: Options = {}) {
    const steps = options.mail ?? ['sent'];
    let call = 0;
    const repository = {
        findDispatch: vi.fn(async () => (options.dispatch === undefined ? dispatch() : options.dispatch)),
        reserve: vi.fn(async () => (options.reserved === undefined ? 42 : options.reserved)),
        recordOutcome: vi.fn(async () => {
            if (options.recordThrows) throw new Error('db down');
            return !options.superseded;
        }),
    };
    const mailer = {
        send: vi.fn(async () => {
            const step = steps[Math.min(call, steps.length - 1)]!;
            call += 1;
            if (step === 'throw') throw new Error('connect ECONNREFUSED smtp.provider.test');
            return step === 'failed' ? { status: 'failed' as const, error: 'SMTP did not accept any recipient.' } : { status: step };
        }),
    };
    const wait = vi.fn(async () => {});
    const config = { get: vi.fn(() => 'http://web.test/') };
    const service = new CustomerStatusNoticeService(repository as any, mailer as any, config as any);
    const handle = (e: DispatchStatusChangedEvent = event()) => service.handle(e, NOW, wait);
    return { service, repository, mailer, wait, handle };
}

const outcomeOf = (repository: ReturnType<typeof build>['repository']) => (repository.recordOutcome.mock.calls[0] as any[])[1];

describe('CustomerStatusNoticeService.handleIncident', () => {
    const incident = { dispatchId: 7, reportedAt: '2026-11-19T15:00:00.000Z' };

    it('sends the incident email when the order is in incident, keyed by the report time', async () => {
        const { service, repository, mailer } = build({ dispatch: dispatch({ currentStatus: 'incident' }) });
        expect(await service.handleIncident(incident)).toBe('sent');
        expect(mailer.send).toHaveBeenCalledTimes(1);
        expect((mailer.send.mock.calls[0]![0] as any).subject).toBe('Tuvimos un inconveniente con tu entrega');
        expect(repository.reserve).toHaveBeenCalledWith(expect.objectContaining({
            idempotencyKey: 'status_change:7:incident:2026-11-19T15:00:00.000Z', occurredAt: '2026-11-19T15:00:00.000Z',
        }));
    });

    it('ignores an incident event of an order that is not in incident (warehouse receipt) or does not exist', async () => {
        const other = build({ dispatch: dispatch({ currentStatus: 'returned' }) });
        expect(await other.service.handleIncident(incident)).toBe('ignored');
        const missing = build({ dispatch: null });
        expect(await missing.service.handleIncident(incident)).toBe('ignored');
        expect(other.mailer.send).not.toHaveBeenCalled();
        expect(missing.mailer.send).not.toHaveBeenCalled();
    });
});

describe('CustomerStatusNoticeService.handle: what is sent', () => {
    it('sends one email with the shown status, the time, the code and the tracking link', async () => {
        const { handle, mailer } = build();

        expect(await handle()).toBe('sent');

        expect(mailer.send).toHaveBeenCalledTimes(1);
        const mail = mailer.send.mock.calls[0]![0] as any;
        expect(mail).toMatchObject({ to: 'ana@example.com', subject: 'Tu pedido fue entregado', template: 'status-change' });
        expect(mail.context).toMatchObject({
            statusLabel: 'Entregado', trackingCode: 'DSP-2026-00007', trackingUrl: 'http://web.test/seguimiento/secret-token',
        });
        expect(mail.context.occurredAt).toContain('10:30');
    });

    it('keeps the token and the address out of the delivery metadata', async () => {
        const { handle, mailer } = build();
        await handle();
        const mail = mailer.send.mock.calls[0]![0] as any;
        expect(JSON.stringify(mail.metadata)).not.toMatch(/secret-token|ana@example|token/);
        expect(mail.metadata).toMatchObject({ customerNotificationId: 42 });
    });

    it('sends nothing for a status that is not in the table, without even reading the dispatch', async () => {
        const { handle, repository, mailer } = build();
        expect(await handle(event({ status: 'assigned', previousStatus: 'scheduled' }))).toBe('ignored');
        expect(await handle(event({ status: 'delivered', previousStatus: 'delivered' }))).toBe('ignored');
        expect(repository.findDispatch).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it('sends nothing for a dispatch that is not a delivery or does not exist', async () => {
        const pickup = build({ dispatch: dispatch({ type: 'supplier_pickup' }) });
        expect(await pickup.handle()).toBe('ignored');
        const missing = build({ dispatch: null });
        expect(await missing.handle()).toBe('ignored');
        expect(pickup.mailer.send).not.toHaveBeenCalled();
        expect(missing.mailer.send).not.toHaveBeenCalled();
    });

    it('sends nothing when the customer has no email, and does not register it', async () => {
        const { handle, mailer, repository } = build({ dispatch: dispatch({ contactEmail: '  ' }) });
        expect(await handle()).toBe('no-recipient');
        expect(repository.reserve).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it('sends without a link when the token expired', async () => {
        const { handle, mailer } = build({ dispatch: dispatch({ trackingTokenExpiresAt: new Date('2020-01-01T00:00:00Z') }) });
        await handle();
        expect((mailer.send.mock.calls[0]![0] as any).context.trackingUrl).toBe('');
    });
});

describe('CustomerStatusNoticeService.handle: one logical send per event', () => {
    it('registers the email with the idempotency key, the normalized recipient and the template version', async () => {
        const { handle, repository } = build({ dispatch: dispatch({ contactEmail: ' Ana@Example.COM ' }) });
        await handle();
        expect(repository.reserve).toHaveBeenCalledWith({
            dispatchId: 7,
            notificationType: 'status_change',
            idempotencyKey: 'status_change:7:delivered:2026-11-19T14:30:00.000Z',
            sourceEventKey: '7:delivered:2026-11-19T14:30:00.000Z',
            dispatchStatus: 'delivered',
            occurredAt: '2026-11-19T14:30:00.000Z',
            recipient: 'ana@example.com',
            template: 'status-change',
            templateVersion: 1,
        });
    });

    it('sends nothing, and records nothing, when the key was already registered', async () => {
        const { handle, mailer, repository } = build({ reserved: null });
        expect(await handle()).toBe('duplicate');
        expect(mailer.send).not.toHaveBeenCalled();
        expect(repository.recordOutcome).not.toHaveBeenCalled();
    });

    it('asks for the same key for two deliveries of the same event, so only one gets to send', async () => {
        const { handle, repository } = build();
        await handle();
        await handle();
        const [first, second] = repository.reserve.mock.calls.map((call) => (call as any[])[0].idempotencyKey);
        expect(second).toBe(first);
    });
});

describe('CustomerStatusNoticeService.handle: recovering from the provider', () => {
    it('records a sent email after one attempt', async () => {
        const { handle, repository, wait } = build();
        await handle();
        expect(repository.recordOutcome).toHaveBeenCalledWith(42, { status: 'sent', attemptsMade: 1, nextAttemptAt: null, lastError: null });
        expect(wait).not.toHaveBeenCalled();
    });

    it('retries a transient failure right away, waiting 500 ms and then 1 s, and records the success', async () => {
        const { handle, mailer, repository, wait } = build({ mail: ['failed', 'throw', 'sent'] });
        expect(await handle()).toBe('sent');
        expect(mailer.send).toHaveBeenCalledTimes(3);
        expect(wait.mock.calls.map((call) => (call as any[])[0])).toEqual([500, 1000]);
        expect(repository.recordOutcome).toHaveBeenCalledWith(42, { status: 'sent', attemptsMade: 3, nextAttemptAt: null, lastError: null });
    });

    it('leaves the email retrying, 5 minutes ahead, when the three attempts fail: the dispatch transition is not touched', async () => {
        const { handle, mailer, repository } = build({ mail: ['failed'] });
        expect(await handle()).toBe('failed');
        expect(mailer.send).toHaveBeenCalledTimes(3);
        expect(outcomeOf(repository)).toEqual({
            status: 'retrying', attemptsMade: 3, nextAttemptAt: new Date('2026-11-19T16:05:00.000Z'), lastError: 'SMTP did not accept any recipient.',
        });
    });

    it('treats an error thrown by the provider as a transient failure, with the error sanitized', async () => {
        const { handle, repository } = build({ mail: ['throw'] });
        expect(await handle()).toBe('failed');
        const outcome = outcomeOf(repository);
        expect(outcome.status).toBe('retrying');
        expect(outcome.lastError).toBe('Error: connect ECONNREFUSED smtp.provider.test');
    });

    it('does not retry a bounce: it is recorded as permanent after one attempt', async () => {
        const { handle, mailer, repository, wait } = build({ mail: ['bounced'] });
        expect(await handle()).toBe('bounced');
        expect(mailer.send).toHaveBeenCalledTimes(1);
        expect(wait).not.toHaveBeenCalled();
        expect(outcomeOf(repository)).toEqual({
            status: 'bounced', attemptsMade: 1, nextAttemptAt: null, lastError: 'The mail provider rejected the recipient.',
        });
    });

    it('never stores the address or the link of the provider error', async () => {
        const { service, repository } = build();
        (service as any).mailer.send = vi.fn(async () => ({ status: 'failed', error: '550 <ana@example.com> rejected, see https://x.test/seguimiento/secret-token-value-123' }));
        await service.handle(event(), NOW, async () => {});
        const { lastError } = outcomeOf(repository);
        expect(lastError).not.toMatch(/ana@|https|secret-token/);
    });

    it('survives an outcome that cannot be recorded: the row keeps its lease for the recovery task', async () => {
        const { handle } = build({ recordThrows: true });
        expect(await handle()).toBe('sent');
    });

    it('does not fail when another process already took the row over', async () => {
        const { handle } = build({ superseded: true });
        expect(await handle()).toBe('sent');
    });
});
