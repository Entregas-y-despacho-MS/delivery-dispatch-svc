import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';

/** `audit_logs.action` of an alert of the generator (`user_id` NULL: the system raised it). */
export const PLAN_ALERT_ACTION = 'plan_generation_alert';

/** Internal event after the alert is stored; ST-53.2 forwards it to the coordinators' room. */
export const PLANNING_ALERT_EVENT = 'planning.alert';

export type PlanAlertSeverity = 'blocking' | 'exception' | 'warning';

export type PlanAlertKind =
    | 'settings_missing'
    | 'osrm_unavailable'
    | 'deadline_exceeded'
    | 'no_vehicle_fits'
    | 'rescheduled_date_not_plannable'
    | 'osrm_table_limit_exceeded'
    | 'no_vehicle_available'
    | 'below_min_orders'
    | 'no_driver_available'
    | 'holidays_not_configured'
    | 'lot_split_by_table_limit'
    | 'zone_deleted';

export interface PlanningAlertEvent {
    kind: PlanAlertKind;
    severity: PlanAlertSeverity;
    detail: Record<string, unknown>;
    occurredAt: string;
}

const SEVERITY: Record<PlanAlertKind, PlanAlertSeverity> = {
    settings_missing: 'blocking',
    osrm_unavailable: 'blocking',
    deadline_exceeded: 'exception',
    no_vehicle_fits: 'exception',
    rescheduled_date_not_plannable: 'exception',
    osrm_table_limit_exceeded: 'exception',
    no_vehicle_available: 'exception',
    below_min_orders: 'warning',
    no_driver_available: 'warning',
    holidays_not_configured: 'warning',
    lot_split_by_table_limit: 'warning',
    zone_deleted: 'warning',
};

/**
 * Alerts to the coordinator (plan §2.8). Each one is stored in `audit_logs` and then announced as the
 * internal event `planning.alert`, after the row is committed. Raising an alert never fails the run:
 * if it cannot be stored it is only logged.
 */
@Injectable()
export class PlanningAlertsService {
    private readonly logger = new Logger(PlanningAlertsService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly events: EventEmitter2,
    ) {}

    severityOf(kind: PlanAlertKind): PlanAlertSeverity {
        return SEVERITY[kind];
    }

    async raise(kind: PlanAlertKind, detail: Record<string, unknown>): Promise<void> {
        const severity = SEVERITY[kind];
        const occurredAt = new Date().toISOString();
        try {
            await this.dataSource.query('INSERT INTO audit_logs (user_id, action, detail) VALUES (NULL, $1, $2)', [
                PLAN_ALERT_ACTION,
                JSON.stringify({ kind, severity, ...detail }),
            ]);
        } catch (error) {
            this.logger.error(`Alert "${kind}" could not be stored: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const event: PlanningAlertEvent = { kind, severity, detail, occurredAt };
        this.events.emit(PLANNING_ALERT_EVENT, event);
    }
}
