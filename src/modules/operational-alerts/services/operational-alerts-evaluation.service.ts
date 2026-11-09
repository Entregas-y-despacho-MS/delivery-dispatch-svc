import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../../settings/services/settings.service.js';
import { SlaReportService } from '../../../app/sla-report/services/sla-report.service.js';
import { SlaGroupBy } from '../../../app/sla-report/domain/sla-group-by.js';
import { OPERATING_TIME_ZONE, todayInOperatingTimeZone } from '../../dispatch/dispatches/utils/operating-date.util.js';
import { OperationalAlertKindEnum, OperationalAlertSeverityEnum } from '../../../shared/enums/operational-alert.enum.js';
import { OperationalAlertsService } from './operational-alerts.service.js';

const DEFAULT_GPS_STALE_MINUTES = 5;
const DEFAULT_DRIVER_INCIDENT_PER_DAY = 3;
const DEFAULT_SLA_MIN_ON_TIME_PCT = 90;

interface GpsStaleRow {
    driver_id: number;
    zone_id: number | null;
    vehicle_id: number | null;
    last_location_at: Date | null;
}

interface DriverIncidentRow {
    driver_id: number;
    zone_id: number | null;
    incident_count: number;
}

/**
 * Escenario 2 de ES-66: las tres evaluaciones periódicas contra los umbrales de ES-67. Llamado desde
 * `OperationalAlertsEvaluationTask` cada minuto (`ScheduledTaskRegistry`) — cada método es
 * independiente y no lanza si una de las otras dos falla no la afecta (ver `run()` del task).
 */
@Injectable()
export class OperationalAlertsEvaluationService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly settings: SettingsService,
        private readonly sla: SlaReportService,
        private readonly alerts: OperationalAlertsService,
    ) {}

    /** Despacho en ruta cuya última posición conocida es nula o más vieja que `gps_stale_alert_minutes`. */
    async evaluateGpsStale(): Promise<void> {
        const minutes = await this.settings.getNumber('gps_stale_alert_minutes', DEFAULT_GPS_STALE_MINUTES);
        const rows: GpsStaleRow[] = await this.dataSource.query(
            `SELECT rb.driver_id, rb.delivery_zone_id AS zone_id, rb.vehicle_id, lastpos.last_location_at
               FROM route_batches rb
               LEFT JOIN LATERAL (
                   SELECT d.last_location_at
                     FROM dispatches d
                    WHERE d.route_batch_id = rb.route_batch_id AND d.last_location_at IS NOT NULL
                    ORDER BY d.last_location_at DESC
                    LIMIT 1
               ) lastpos ON true
              WHERE rb.status = 'in_execution'`,
        );

        const staleBefore = Date.now() - minutes * 60_000;
        for (const row of rows) {
            const lastAt = row.last_location_at === null ? null : new Date(row.last_location_at).getTime();
            if (lastAt !== null && lastAt >= staleBefore) continue;
            await this.alerts.raise({
                kind: OperationalAlertKindEnum.GPS_STALE,
                severity: OperationalAlertSeverityEnum.WARNING,
                zoneId: row.zone_id,
                driverId: row.driver_id,
                vehicleId: row.vehicle_id,
                detail: { lastLocationAt: row.last_location_at === null ? null : new Date(row.last_location_at).toISOString(), thresholdMinutes: minutes },
            });
        }
    }

    /** Repartidores con `COUNT(dispatch_incidents)` de hoy (día operativo) >= `driver_incident_alert_per_day`. */
    async evaluateDriverIncidents(): Promise<void> {
        const threshold = await this.settings.getNumber('driver_incident_alert_per_day', DEFAULT_DRIVER_INCIDENT_PER_DAY);
        const today = todayInOperatingTimeZone();
        const rows: DriverIncidentRow[] = await this.dataSource.query(
            `SELECT rb.driver_id, rb.delivery_zone_id AS zone_id, COUNT(*)::int AS incident_count
               FROM dispatch_incidents i
               JOIN dispatches d ON d.dispatch_id = i.dispatch_id
               JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
              WHERE rb.driver_id IS NOT NULL
                AND i.created_at >= ($1::date)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}'
                AND i.created_at < (($1::date + 1)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}')
              GROUP BY rb.driver_id, rb.delivery_zone_id
             HAVING COUNT(*) >= $2`,
            [today, threshold],
        );

        for (const row of rows) {
            await this.alerts.raise({
                kind: OperationalAlertKindEnum.DRIVER_INCIDENTS,
                severity: OperationalAlertSeverityEnum.WARNING,
                zoneId: row.zone_id,
                driverId: row.driver_id,
                detail: { incidentCount: row.incident_count, threshold, date: today },
            });
        }
    }

    /** Por zona, % de entregas a tiempo del día operativo bajo `sla_alert_min_on_time_pct`. Zonas sin ninguna entrega hoy se omiten. */
    async evaluateSlaBelowThreshold(): Promise<void> {
        const threshold = await this.settings.getNumber('sla_alert_min_on_time_pct', DEFAULT_SLA_MIN_ON_TIME_PCT);
        const today = todayInOperatingTimeZone();
        const report = await this.sla.compute(today, today, SlaGroupBy.ZONE);

        for (const row of report.rows) {
            if (row.deliveredCount === 0 || row.groupId === null) continue;
            if (row.onTimePercentage >= threshold) continue;
            await this.alerts.raise({
                kind: OperationalAlertKindEnum.SLA_BELOW_THRESHOLD,
                severity: OperationalAlertSeverityEnum.WARNING,
                zoneId: row.groupId,
                detail: { onTimePercentage: row.onTimePercentage, threshold, deliveredCount: row.deliveredCount, date: today },
            });
        }
    }
}
