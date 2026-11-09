import { describe, expect, it, vi } from 'vitest';
import { OperationalAlertsEvaluationService } from './operational-alerts-evaluation.service.js';
import { OperationalAlertKindEnum, OperationalAlertSeverityEnum } from '../../../shared/enums/operational-alert.enum.js';

function build(settingsOverrides: Record<string, number> = {}) {
    const dataSource = { query: vi.fn() };
    const settings = { getNumber: vi.fn((key: string, fallback: number) => Promise.resolve(settingsOverrides[key] ?? fallback)) };
    const sla = { compute: vi.fn() };
    const alerts = { raise: vi.fn() };
    const service = new OperationalAlertsEvaluationService(dataSource as never, settings as never, sla as never, alerts as never);
    return { service, dataSource, settings, sla, alerts };
}

describe('OperationalAlertsEvaluationService.evaluateGpsStale', () => {
    it('raises gps_stale for a batch whose last position is older than the threshold', async () => {
        const { service, dataSource, alerts } = build({ gps_stale_alert_minutes: 5 });
        dataSource.query.mockResolvedValue([
            { driver_id: 7, zone_id: 2, vehicle_id: 9, last_location_at: new Date(Date.now() - 10 * 60_000), started_at: new Date(Date.now() - 60 * 60_000) },
        ]);

        await service.evaluateGpsStale();

        expect(alerts.raise).toHaveBeenCalledWith(expect.objectContaining({
            kind: OperationalAlertKindEnum.GPS_STALE, severity: OperationalAlertSeverityEnum.WARNING,
            zoneId: 2, driverId: 7, vehicleId: 9,
        }));
    });

    it('does not raise for a batch that never reported a position but started less than the threshold ago', async () => {
        const { service, dataSource, alerts } = build({ gps_stale_alert_minutes: 5 });
        dataSource.query.mockResolvedValue([{ driver_id: 7, zone_id: 2, vehicle_id: 9, last_location_at: null, started_at: new Date(Date.now() - 60_000) }]);

        await service.evaluateGpsStale();

        expect(alerts.raise).not.toHaveBeenCalled();
    });

    it('raises for a batch that never reported a position once the threshold has passed since it started', async () => {
        const { service, dataSource, alerts } = build({ gps_stale_alert_minutes: 5 });
        dataSource.query.mockResolvedValue([{ driver_id: 7, zone_id: 2, vehicle_id: 9, last_location_at: null, started_at: new Date(Date.now() - 10 * 60_000) }]);

        await service.evaluateGpsStale();

        expect(alerts.raise).toHaveBeenCalledOnce();
    });

    it('does not raise when the last position is recent enough', async () => {
        const { service, dataSource, alerts } = build({ gps_stale_alert_minutes: 5 });
        dataSource.query.mockResolvedValue([
            { driver_id: 7, zone_id: 2, vehicle_id: 9, last_location_at: new Date(Date.now() - 60_000), started_at: new Date(Date.now() - 60 * 60_000) },
        ]);

        await service.evaluateGpsStale();

        expect(alerts.raise).not.toHaveBeenCalled();
    });
});

describe('OperationalAlertsEvaluationService.evaluateDriverIncidents', () => {
    it('raises driver_incidents without a zone for every row the query already filtered by the threshold', async () => {
        const { service, dataSource, alerts } = build({ driver_incident_alert_per_day: 3 });
        dataSource.query.mockResolvedValue([{ driver_id: 7, incident_count: 4 }]);

        await service.evaluateDriverIncidents();

        expect(dataSource.query.mock.calls[0]?.[1]).toEqual([expect.any(String), 3]);
        expect(dataSource.query.mock.calls[0]?.[0]).not.toContain('delivery_zone_id');
        expect(alerts.raise).toHaveBeenCalledWith(expect.objectContaining({
            kind: OperationalAlertKindEnum.DRIVER_INCIDENTS, zoneId: null, driverId: 7,
            detail: expect.objectContaining({ incidentCount: 4, threshold: 3 }),
        }));
    });

    it('raises nothing when the query returns no rows (no driver reached the threshold)', async () => {
        const { service, dataSource, alerts } = build();
        dataSource.query.mockResolvedValue([]);

        await service.evaluateDriverIncidents();

        expect(alerts.raise).not.toHaveBeenCalled();
    });
});

describe('OperationalAlertsEvaluationService.evaluateSlaBelowThreshold', () => {
    it('raises sla_below_threshold for a zone below the threshold with enough deliveries today', async () => {
        const { service, sla, alerts } = build({ sla_alert_min_on_time_pct: 90 });
        sla.compute.mockResolvedValue({ rows: [{ groupId: 2, groupName: 'Zona Sur', deliveredCount: 10, onTimePercentage: 80 }] });

        await service.evaluateSlaBelowThreshold();

        expect(alerts.raise).toHaveBeenCalledWith(expect.objectContaining({
            kind: OperationalAlertKindEnum.SLA_BELOW_THRESHOLD, zoneId: 2,
            detail: expect.objectContaining({ onTimePercentage: 80, threshold: 90 }),
        }));
    });

    it('does not raise for a zone at or above the threshold', async () => {
        const { service, sla, alerts } = build({ sla_alert_min_on_time_pct: 90 });
        sla.compute.mockResolvedValue({ rows: [{ groupId: 2, groupName: 'Zona Sur', deliveredCount: 10, onTimePercentage: 90 }] });

        await service.evaluateSlaBelowThreshold();

        expect(alerts.raise).not.toHaveBeenCalled();
    });

    it('does not raise for a zone whose sample is too small today, even if onTimePercentage is 0', async () => {
        const { service, sla, alerts } = build({ sla_alert_min_on_time_pct: 90 });
        sla.compute.mockResolvedValue({ rows: [{ groupId: 2, groupName: 'Zona Sur', deliveredCount: 1, onTimePercentage: 0 }] });

        await service.evaluateSlaBelowThreshold();

        expect(alerts.raise).not.toHaveBeenCalled();
    });

    it('raises once the sample is large enough and still below the threshold', async () => {
        const { service, sla, alerts } = build({ sla_alert_min_on_time_pct: 90 });
        sla.compute.mockResolvedValue({ rows: [{ groupId: 2, groupName: 'Zona Sur', deliveredCount: 5, onTimePercentage: 60 }] });

        await service.evaluateSlaBelowThreshold();

        expect(alerts.raise).toHaveBeenCalledOnce();
    });

    it('skips the row without a zone (groupId null)', async () => {
        const { service, sla, alerts } = build({ sla_alert_min_on_time_pct: 90 });
        sla.compute.mockResolvedValue({ rows: [{ groupId: null, groupName: null, deliveredCount: 10, onTimePercentage: 50 }] });

        await service.evaluateSlaBelowThreshold();

        expect(alerts.raise).not.toHaveBeenCalled();
    });
});
