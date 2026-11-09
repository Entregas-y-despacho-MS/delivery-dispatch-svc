import { describe, expect, it, vi } from 'vitest';
import { FleetMaintenanceReportRepository } from './fleet-maintenance-report.repository.js';

describe('FleetMaintenanceReportRepository', () => {
    it('queries overlapping maintenance by inclusive range and maps the aggregate rows', async () => {
        const query = vi.fn().mockResolvedValue([{ vehicle_id: 7, maintenance_count: 3, days_in_maintenance: 6 }]);
        const repository = new FleetMaintenanceReportRepository({ query } as never);

        await expect(repository.aggregate('2026-10-01', '2026-10-31')).resolves.toEqual([
            { vehicleId: 7, maintenanceCount: 3, daysInMaintenance: 6 },
        ]);
        expect(query).toHaveBeenCalledWith(expect.stringContaining("completed_at IS NULL OR (completed_at AT TIME ZONE 'America/La_Paz')::date >= $1::date"), ['2026-10-01', '2026-10-31']);
        expect(query.mock.calls[0][0]).toContain("(created_at AT TIME ZONE 'America/La_Paz')::date <= $2::date");
    });
});
