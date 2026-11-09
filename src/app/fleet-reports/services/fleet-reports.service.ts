import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../../../plugins/cache/cache.port.js';
import { FLEET_REPORTS_CACHE_TTL_SECONDS, fleetReportsCacheKey } from '../domain/fleet-reports-cache-key.js';
import { assertSlaRange } from '../../sla-report/domain/sla-date-range.js';
import { SlaGroupBy } from '../../sla-report/domain/sla-group-by.js';
import { SlaReportService } from '../../sla-report/services/sla-report.service.js';
import type { FleetReportsDto, FleetReportVehicleRowDto } from '../dto/fleet-reports.dto.js';
import { FleetMaintenanceReportRepository } from '../repositories/fleet-maintenance-report.repository.js';

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : '';
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSlaRow(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const row = value as Record<string, unknown>;
    return (row.groupId === null || (typeof row.groupId === 'number' && Number.isInteger(row.groupId) && row.groupId > 0))
        && (row.groupName === null || typeof row.groupName === 'string')
        && isCount(row.closedCount) && isCount(row.deliveredCount) && isCount(row.onTimeCount) && isCount(row.lateCount) && isCount(row.incidentCount)
        && row.deliveredCount <= row.closedCount && row.onTimeCount + row.lateCount <= row.deliveredCount
        && typeof row.onTimePercentage === 'number' && Number.isFinite(row.onTimePercentage) && row.onTimePercentage >= 0 && row.onTimePercentage <= 100
        && (row.averageDelayMinutes === null || (typeof row.averageDelayMinutes === 'number' && Number.isFinite(row.averageDelayMinutes) && row.averageDelayMinutes >= 0))
        && (row.averageCycleMinutes === null || (typeof row.averageCycleMinutes === 'number' && Number.isFinite(row.averageCycleMinutes) && row.averageCycleMinutes >= 0))
        && ((row.averageDelayMinutes === null) === (row.lateCount === 0));
}

function isReport(value: unknown, from: string, to: string): value is FleetReportsDto {
    if (typeof value !== 'object' || value === null) return false;
    const report = value as Record<string, unknown>;
    return report.from === from && report.to === to && Array.isArray(report.drivers) && Array.isArray(report.vehicles)
        && report.drivers.every(isSlaRow)
        && report.vehicles.every((row) => isSlaRow(row) && isCount((row as FleetReportVehicleRowDto).maintenanceCount)
            && isCount((row as FleetReportVehicleRowDto).daysInMaintenance));
}

/** Combined ST-65.1 response. The cache stores the whole response atomically under one range key. */
@Injectable()
export class FleetReportsService {
    private readonly logger = new Logger(FleetReportsService.name);

    constructor(
        private readonly sla: SlaReportService,
        private readonly maintenance: FleetMaintenanceReportRepository,
        private readonly cache: CacheService,
    ) {}

    async get(from: string, to: string): Promise<FleetReportsDto> {
        assertSlaRange(from, to);
        const key = fleetReportsCacheKey(from, to);
        try {
            const raw = await this.cache.get(key);
            if (raw !== null) {
                const parsed: unknown = JSON.parse(raw);
                if (isReport(parsed, from, to)) return parsed;
                this.logger.warn(`The cached fleet report under ${key} is not valid; computing from PostgreSQL.`);
            }
        } catch (error) {
            this.logger.warn(`Could not read the fleet report cache (${key}); computing from PostgreSQL. ${messageOf(error)}`.trim());
        }

        const [drivers, vehicles, maintenance] = await Promise.all([
            this.sla.compute(from, to, SlaGroupBy.DRIVER),
            this.sla.compute(from, to, SlaGroupBy.VEHICLE),
            this.maintenance.aggregate(from, to),
        ]);
        const maintenanceByVehicle = new Map(maintenance.map((row) => [row.vehicleId, row]));
        const report: FleetReportsDto = {
            from,
            to,
            drivers: drivers.rows,
            vehicles: vehicles.rows.map((row) => {
                const figures = row.groupId === null ? undefined : maintenanceByVehicle.get(row.groupId);
                return { ...row, maintenanceCount: figures?.maintenanceCount ?? 0, daysInMaintenance: figures?.daysInMaintenance ?? 0 };
            }),
        };
        try {
            await this.cache.setWithTtl(key, JSON.stringify(report), FLEET_REPORTS_CACHE_TTL_SECONDS);
        } catch (error) {
            this.logger.warn(`Could not store the fleet report in the cache (${key}). ${messageOf(error)}`.trim());
        }
        return report;
    }
}
