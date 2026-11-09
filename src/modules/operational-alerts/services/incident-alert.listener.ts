import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { INCIDENT_REPORTED_EVENT } from '../../../app/dispatch-incidents/domain/incident-report.js';
import { OperationalAlertKindEnum, OperationalAlertSeverityEnum } from '../../../shared/enums/operational-alert.enum.js';
import { OperationalAlertsService } from './operational-alerts.service.js';

interface IncidentReportedEvent {
    dispatchId: number;
    incidentId: string;
    reasonCode: string;
    reportedAt: string;
    criticality: string;
}

interface DispatchSubjectRow {
    zone_id: number | null;
    driver_id: number | null;
    vehicle_id: number | null;
}

/**
 * Escenario 1 de ES-66: toda incidencia reportada (`dispatch.incident_reported`, ST-32.2) se trata
 * como crítica — `criticality` del evento viene siempre `'high'` hoy, sin una columna real de
 * severidad en `incident_reasons` (decisión del usuario, 2026-11-09: no agregar esa columna todavía).
 */
@Injectable()
export class IncidentAlertListener {
    private readonly logger = new Logger(IncidentAlertListener.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly alerts: OperationalAlertsService,
    ) {}

    @OnEvent(INCIDENT_REPORTED_EVENT, { async: true })
    async handle(event: IncidentReportedEvent): Promise<void> {
        const [subject]: DispatchSubjectRow[] = await this.dataSource.query(
            `SELECT COALESCE(d.delivery_zone_id, rb.delivery_zone_id) AS zone_id, rb.driver_id, rb.vehicle_id
               FROM dispatches d LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
              WHERE d.dispatch_id = $1`,
            [event.dispatchId],
        );
        if (!subject) {
            this.logger.warn(`Incident ${event.incidentId} reported for unknown dispatch ${event.dispatchId}; no alert raised.`);
            return;
        }

        await this.alerts.raise({
            kind: OperationalAlertKindEnum.CRITICAL_INCIDENT,
            severity: OperationalAlertSeverityEnum.CRITICAL,
            zoneId: subject.zone_id,
            dispatchId: event.dispatchId,
            driverId: subject.driver_id,
            vehicleId: subject.vehicle_id,
            detail: { incidentId: event.incidentId, reasonCode: event.reasonCode, reportedAt: event.reportedAt },
        });
    }
}
