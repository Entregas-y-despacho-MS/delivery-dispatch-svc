import { describe, expect, it, vi } from 'vitest';
import type { DispatchStatusChangedEvent } from '../../dispatch-status/dispatch-status-changed.event.js';
import type { StatusNoticeDispatch } from '../domain/build-status-notice.js';
import { CustomerStatusNoticeService } from './customer-status-notice.service.js';

const event = (over: Partial<DispatchStatusChangedEvent> = {}): DispatchStatusChangedEvent => ({
    dispatchId: 7, status: 'delivered', previousStatus: 'in_transit', version: 3, updatedAt: '2026-11-19T14:30:00.000Z', ...over,
});
const dispatch = (over: Partial<StatusNoticeDispatch> = {}): StatusNoticeDispatch => ({
    dispatchId: 7, type: 'delivery', currentStatus: 'in_transit', contactEmail: 'ana@example.com', trackingCode: 'DSP-2026-00007',
    trackingToken: 'secret-token', trackingTokenExpiresAt: null, ...over,
});

function build(options: { dispatch?: StatusNoticeDispatch | null; reserve?: boolean; mail?: 'sent' | 'bounced' | 'throw'; recordThrows?: boolean } = {}) {
    const repository = {
        findDispatch: vi.fn(async () => (options.dispatch === undefined ? dispatch() : options.dispatch)),
        reserve: vi.fn(async () => options.reserve ?? true),
        recordResult: vi.fn(async () => { if (options.recordThrows) throw new Error('db down'); }),
    };
    const mailer = {
        send: vi.fn(async () => {
            if (options.mail === 'throw') throw new Error('smtp down');
            return { status: options.mail ?? 'sent' };
        }),
    };
    const config = { get: vi.fn(() => 'http://web.test/') };
    return { service: new CustomerStatusNoticeService(repository as any, mailer as any, config as any), repository, mailer };
}

describe('CustomerStatusNoticeService.handleIncident', () => {
    const incident = { dispatchId: 7, reportedAt: '2026-11-19T15:00:00.000Z' };

    it('sends the incident email when the order is in incident, keyed by the report time', async () => {
        const { service, repository, mailer } = build({ dispatch: dispatch({ currentStatus: 'incident' }) });
        expect(await service.handleIncident(incident)).toBe('sent');
        expect(mailer.send).toHaveBeenCalledTimes(1);
        expect((mailer.send.mock.calls[0]![0] as any).subject).toBe('Tuvimos un inconveniente con tu entrega');
        expect(repository.reserve).toHaveBeenCalledWith(7, 'incident', '2026-11-19T15:00:00.000Z');
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

describe('CustomerStatusNoticeService.handle', () => {
    it('sends one email with the shown status, the time, the code and the tracking link', async () => {
        const { service, repository, mailer } = build();

        expect(await service.handle(event())).toBe('sent');

        expect(mailer.send).toHaveBeenCalledTimes(1);
        const mail = mailer.send.mock.calls[0]![0] as any;
        expect(mail).toMatchObject({ to: 'ana@example.com', subject: 'Tu pedido fue entregado', template: 'status-change' });
        expect(mail.context).toMatchObject({
            statusLabel: 'Entregado', trackingCode: 'DSP-2026-00007', trackingUrl: 'http://web.test/seguimiento/secret-token',
        });
        expect(mail.context.occurredAt).toContain('10:30');
        expect(repository.reserve).toHaveBeenCalledWith(7, 'delivered', '2026-11-19T14:30:00.000Z');
        expect(repository.recordResult).toHaveBeenCalledWith(7, 'delivered', '2026-11-19T14:30:00.000Z', 'sent');
    });

    it('keeps the token and the address out of the delivery metadata', async () => {
        const { service, mailer } = build();
        await service.handle(event());
        const mail = mailer.send.mock.calls[0]![0] as any;
        expect(JSON.stringify(mail.metadata)).not.toMatch(/secret-token|ana@example|token/);
    });

    it('sends nothing for a status that is not in the table, without even reading the dispatch', async () => {
        const { service, repository, mailer } = build();
        expect(await service.handle(event({ status: 'assigned', previousStatus: 'scheduled' }))).toBe('ignored');
        expect(await service.handle(event({ status: 'delivered', previousStatus: 'delivered' }))).toBe('ignored');
        expect(repository.findDispatch).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it('sends nothing for a dispatch that is not a delivery or does not exist', async () => {
        const pickup = build({ dispatch: dispatch({ type: 'supplier_pickup' }) });
        expect(await pickup.service.handle(event())).toBe('ignored');
        const missing = build({ dispatch: null });
        expect(await missing.service.handle(event())).toBe('ignored');
        expect(pickup.mailer.send).not.toHaveBeenCalled();
        expect(missing.mailer.send).not.toHaveBeenCalled();
    });

    it('does not send twice for the same transition', async () => {
        const { service, mailer, repository } = build({ reserve: false });
        expect(await service.handle(event())).toBe('duplicate');
        expect(mailer.send).not.toHaveBeenCalled();
        expect(repository.recordResult).not.toHaveBeenCalled();
    });

    it('sends nothing when the customer has no email', async () => {
        const { service, mailer, repository } = build({ dispatch: dispatch({ contactEmail: null }) });
        expect(await service.handle(event())).toBe('no-recipient');
        expect(repository.reserve).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it('sends without a link when the token expired', async () => {
        const { service, mailer } = build({ dispatch: dispatch({ trackingTokenExpiresAt: new Date('2020-01-01T00:00:00Z') }) });
        await service.handle(event());
        expect((mailer.send.mock.calls[0]![0] as any).context.trackingUrl).toBe('');
    });

    it('records a bounce and a transport failure without throwing', async () => {
        const bounced = build({ mail: 'bounced' });
        expect(await bounced.service.handle(event())).toBe('bounced');
        expect(bounced.repository.recordResult).toHaveBeenCalledWith(7, 'delivered', expect.any(String), 'bounced');

        const failed = build({ mail: 'throw' });
        expect(await failed.service.handle(event())).toBe('failed');
        expect(failed.repository.recordResult).toHaveBeenCalledWith(7, 'delivered', expect.any(String), 'failed');
    });

    it('survives a result that cannot be recorded', async () => {
        const { service } = build({ recordThrows: true });
        expect(await service.handle(event())).toBe('sent');
    });
});
