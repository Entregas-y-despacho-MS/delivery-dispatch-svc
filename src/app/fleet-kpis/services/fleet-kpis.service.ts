import { Injectable } from '@nestjs/common';
import { type DriverMetricsPeriod, resolveMetricsRange } from '../../driver-metrics/domain/metrics-period.js';
import { SlaGroupBy } from '../../sla-report/domain/sla-group-by.js';
import { SlaReportService } from '../../sla-report/services/sla-report.service.js';
import type { FleetKpisDto } from '../dto/fleet-kpis.dto.js';

/**
 * The fleet KPIs (RF-A14): the SLA aggregation of ST-54.2 for a period, by driver and by vehicle. It does not query
 * or cache anything itself: `SlaReportService.aggregate` serves each grouping from Redis (10 minutes, key
 * `reports:sla:{groupBy}:{from}:{to}`) or from PostgreSQL.
 */
@Injectable()
export class FleetKpisService {
    constructor(private readonly sla: SlaReportService) {}

    async get(period: DriverMetricsPeriod, now: Date = new Date()): Promise<FleetKpisDto> {
        const { from, to } = resolveMetricsRange(period, now);
        const [byDriver, byVehicle] = await Promise.all([
            this.sla.aggregate(from, to, SlaGroupBy.DRIVER),
            this.sla.aggregate(from, to, SlaGroupBy.VEHICLE),
        ]);
        // Both groupings count the same closed dispatches, so their totals are equal; the drivers' are used.
        return { period, from, to, totals: byDriver.totals, drivers: byDriver.rows, vehicles: byVehicle.rows };
    }
}
