import { describe, expect, it, vi } from 'vitest';
import { IncidentAlertListener } from './incident-alert.listener.js';
import { OperationalAlertKindEnum, OperationalAlertSeverityEnum } from '../../../shared/enums/operational-alert.enum.js';

function build() {
    const dataSource = { query: vi.fn() };
    const alerts = { raise: vi.fn() };
    const listener = new IncidentAlertListener(dataSource as never, alerts as never);
    return { listener, dataSource, alerts };
}

describe('IncidentAlertListener', () => {
    it('raises a critical_incident alert resolving zone/driver/vehicle from the dispatch', async () => {
        const { listener, dataSource, alerts } = build();
        dataSource.query.mockResolvedValue([{ zone_id: 2, driver_id: 7, vehicle_id: 9 }]);

        await listener.handle({ dispatchId: 55, incidentId: 'INC-1', reasonCode: 'INC-ACCIDENT', reportedAt: '2026-11-09T14:00:00.000Z', criticality: 'high' });

        expect(alerts.raise).toHaveBeenCalledWith({
            kind: OperationalAlertKindEnum.CRITICAL_INCIDENT,
            severity: OperationalAlertSeverityEnum.CRITICAL,
            zoneId: 2, dispatchId: 55, driverId: 7, vehicleId: 9,
            detail: { incidentId: 'INC-1', reasonCode: 'INC-ACCIDENT', reportedAt: '2026-11-09T14:00:00.000Z' },
        });
    });

    it('does nothing, and never queries the dispatch, when the incident is not high criticality', async () => {
        const { listener, dataSource, alerts } = build();

        await listener.handle({ dispatchId: 55, incidentId: 'INC-1', reasonCode: 'INC-ACCIDENT', reportedAt: '2026-11-09T14:00:00.000Z', criticality: 'low' });

        expect(dataSource.query).not.toHaveBeenCalled();
        expect(alerts.raise).not.toHaveBeenCalled();
    });

    it('does nothing (and never throws) when the dispatch cannot be resolved', async () => {
        const { listener, dataSource, alerts } = build();
        dataSource.query.mockResolvedValue([]);

        await listener.handle({ dispatchId: 999, incidentId: 'INC-1', reasonCode: 'INC-ACCIDENT', reportedAt: '2026-11-09T14:00:00.000Z', criticality: 'high' });

        expect(alerts.raise).not.toHaveBeenCalled();
    });
});
