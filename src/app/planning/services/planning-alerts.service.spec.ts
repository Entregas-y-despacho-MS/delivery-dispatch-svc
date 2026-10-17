import { describe, expect, it, vi } from 'vitest';
import { PLAN_ALERT_ACTION, PLANNING_ALERT_EVENT, PlanningAlertsService } from './planning-alerts.service.js';

function build(queryImpl?: () => Promise<unknown>) {
    const order: string[] = [];
    const dataSource = { query: vi.fn(async (...args: unknown[]) => { order.push('stored'); return queryImpl ? await queryImpl() : args; }) };
    const events = { emit: vi.fn(() => { order.push('emitted'); return true; }) };
    return { service: new PlanningAlertsService(dataSource as any, events as any), dataSource, events, order };
}

describe('PlanningAlertsService', () => {
    it('stores the alert in audit_logs and then announces planning.alert', async () => {
        const { service, dataSource, events, order } = build();

        await service.raise('no_vehicle_fits', { zoneId: 7, zoneCode: 'ZON-SUR', zoneName: 'Achumani', dispatchId: 5 });

        const [sql, params] = dataSource.query.mock.calls[0] as [string, string[]];
        expect(sql).toContain('INSERT INTO audit_logs');
        expect(params[0]).toBe(PLAN_ALERT_ACTION);
        expect(JSON.parse(params[1])).toMatchObject({ kind: 'no_vehicle_fits', severity: 'exception', zoneCode: 'ZON-SUR' });
        expect(events.emit).toHaveBeenCalledWith(PLANNING_ALERT_EVENT, expect.objectContaining({
            kind: 'no_vehicle_fits', severity: 'exception', detail: expect.objectContaining({ dispatchId: 5 }),
        }));
        expect(order).toEqual(['stored', 'emitted']);
    });

    it.each([
        ['settings_missing', 'blocking'], ['osrm_unavailable', 'blocking'],
        ['deadline_exceeded', 'exception'], ['osrm_table_limit_exceeded', 'exception'],
        ['final_review_overdue', 'exception'], ['final_review_escalated', 'exception'],
        ['below_min_orders', 'warning'], ['zone_deleted', 'warning'], ['holidays_not_configured', 'warning'],
    ] as const)('classifies %s as %s', (kind, severity) => {
        expect(build().service.severityOf(kind)).toBe(severity);
    });

    it('never fails the run when the alert cannot be stored, and does not announce it', async () => {
        const { service, events } = build(async () => { throw new Error('db down'); });

        await expect(service.raise('zone_deleted', {})).resolves.toBeUndefined();
        expect(events.emit).not.toHaveBeenCalled();
    });
});

describe('PlanningAlertsService.store / announce', () => {
    it('store writes through the given transaction and throws when it cannot, without announcing', async () => {
        const { service, dataSource, events } = build();
        const manager = { query: vi.fn(async () => { throw new Error('tx aborted'); }) };

        await expect(service.store('final_review_overdue', { routeBatchId: 1 }, manager as any)).rejects.toThrow('tx aborted');
        expect(dataSource.query).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
    });

    it('store returns the event without announcing it; announce emits it afterwards', async () => {
        const { service, events } = build();
        const manager = { query: vi.fn(async () => undefined) };

        const event = await service.store('final_review_escalated', { routeBatchId: 2 }, manager as any);

        expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_logs'), [PLAN_ALERT_ACTION, expect.stringContaining('"kind":"final_review_escalated"')]);
        expect(events.emit).not.toHaveBeenCalled();
        service.announce(event);
        expect(events.emit).toHaveBeenCalledWith(PLANNING_ALERT_EVENT, event);
    });
});
