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
 * Una incidencia reportada (`dispatch.incident_reported`) levanta la alerta crítica solo si su
 * motivo es de criticidad alta. El evento trae la criticidad que el catálogo `incident_reasons`
 * asigna a cada motivo (`low` por defecto); las incidencias de criticidad baja no generan alerta.
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
        if (event.criticality !== 'high') return;

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

        // A second incident on the same dispatch while the first one's alert is still open is not a
        // new subject for uq_operational_alerts_open_subject (same kind + dispatch_id) — raise() is a
        // no-op for it, with no second alert and no second notification. Acceptable: a dispatch moves
        // out of in_transit on its first incident, so this can only repeat via a correction flow, not
        // the normal path, and the coordinator reviewing the alert already sees the dispatch itself.
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
