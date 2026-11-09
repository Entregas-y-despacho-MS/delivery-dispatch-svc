import { describe, expect, it, vi } from 'vitest';
import { OperationalAlertsService } from './operational-alerts.service.js';
import { OperationalAlertKindEnum, OperationalAlertSeverityEnum, OperationalAlertStatusEnum } from '../../../shared/enums/operational-alert.enum.js';
import { OperationalAlertNotFoundException, OperationalAlertAlreadyAcknowledgedException } from '../exceptions/index.js';
import { OPERATIONAL_ALERT_RAISED_EVENT } from '../events/operational-alert-raised.event.js';

function build() {
    const dataSource = { query: vi.fn() };
    const events = { emit: vi.fn() };
    const execute = vi.fn();
    const qb = { update: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), execute };
    const rawRepo = { createQueryBuilder: vi.fn(() => qb), existsBy: vi.fn(), findOne: vi.fn() };
    const service = new OperationalAlertsService(rawRepo as never, dataSource as never, events as never);
    return { service, dataSource, events, execute, rawRepo, qb };
}

describe('OperationalAlertsService.raise', () => {
    it('inserts and emits when the subject has no open alert of this kind and was not acknowledged today', async () => {
        const { service, dataSource, events } = build();
        dataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ operational_alert_id: 1 }]);

        await service.raise({
            kind: OperationalAlertKindEnum.CRITICAL_INCIDENT,
            severity: OperationalAlertSeverityEnum.CRITICAL,
            zoneId: 2, dispatchId: 55, driverId: 7, vehicleId: 9,
            detail: { incidentId: 'INC-1' },
        });

        expect(dataSource.query.mock.calls[1]?.[0]).toContain('ON CONFLICT (kind, COALESCE(zone_id, -1)');
        expect(dataSource.query.mock.calls[1]?.[1]).toEqual([
            'critical_incident', 'critical', 2, 55, 7, 9, JSON.stringify({ incidentId: 'INC-1' }),
        ]);
        expect(events.emit).toHaveBeenCalledWith(OPERATIONAL_ALERT_RAISED_EVENT, {
            id: 1, kind: OperationalAlertKindEnum.CRITICAL_INCIDENT, severity: OperationalAlertSeverityEnum.CRITICAL,
            zoneId: 2, dispatchId: 55, driverId: 7, detail: { incidentId: 'INC-1' },
        });
    });

    it('does nothing when a conflict means the subject already has this kind open (no duplicate, no re-notify)', async () => {
        const { service, dataSource, events } = build();
        dataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

        await service.raise({
            kind: OperationalAlertKindEnum.GPS_STALE, severity: OperationalAlertSeverityEnum.WARNING,
            driverId: 7, detail: {},
        });

        expect(events.emit).not.toHaveBeenCalled();
    });

    it('does nothing, and never queries the insert, when the same subject was already acknowledged today', async () => {
        const { service, dataSource, events } = build();
        dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);

        await service.raise({
            kind: OperationalAlertKindEnum.GPS_STALE, severity: OperationalAlertSeverityEnum.WARNING,
            driverId: 7, detail: {},
        });

        expect(dataSource.query).toHaveBeenCalledOnce();
        expect(events.emit).not.toHaveBeenCalled();
    });

    it('does not fail the raise when the listener throws, just logs it', async () => {
        const { service, dataSource, events } = build();
        dataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ operational_alert_id: 1 }]);
        events.emit.mockImplementation(() => { throw new Error('listener failed'); });

        await expect(service.raise({
            kind: OperationalAlertKindEnum.GPS_STALE, severity: OperationalAlertSeverityEnum.WARNING,
            driverId: 7, detail: {},
        })).resolves.toBeUndefined();
    });
});

describe('OperationalAlertsService.acknowledge', () => {
    it('acknowledges an open alert and returns its current state', async () => {
        const { service, execute, rawRepo } = build();
        execute.mockResolvedValue({ affected: 1 });
        rawRepo.findOne.mockResolvedValue({
            id: 1, kind: OperationalAlertKindEnum.GPS_STALE, severity: OperationalAlertSeverityEnum.WARNING,
            zoneId: null, dispatchId: null, driverId: 7, vehicleId: null, detail: {},
            status: OperationalAlertStatusEnum.ACKNOWLEDGED, acknowledgedBy: 9, acknowledgedAt: new Date('2026-11-09T14:05:00Z'),
            createdAt: new Date('2026-11-09T14:00:00Z'),
        });

        const result = await service.acknowledge(1, 9);

        expect(result.status).toBe(OperationalAlertStatusEnum.ACKNOWLEDGED);
        expect(result.acknowledgedBy).toBe(9);
        expect(rawRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it('throws not-found when the alert does not exist', async () => {
        const { service, execute, rawRepo } = build();
        execute.mockResolvedValue({ affected: 0 });
        rawRepo.existsBy.mockResolvedValue(false);

        await expect(service.acknowledge(99, 9)).rejects.toThrow(OperationalAlertNotFoundException);
    });

    it('throws already-acknowledged when it exists but is no longer open', async () => {
        const { service, execute, rawRepo } = build();
        execute.mockResolvedValue({ affected: 0 });
        rawRepo.existsBy.mockResolvedValue(true);

        await expect(service.acknowledge(1, 9)).rejects.toThrow(OperationalAlertAlreadyAcknowledgedException);
    });
});
