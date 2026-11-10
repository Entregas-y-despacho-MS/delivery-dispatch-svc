import { OperationalAlertKindEnum, OperationalAlertSeverityEnum } from '../../../shared/enums/operational-alert.enum.js';

export const OPERATIONAL_ALERT_RAISED_EVENT = 'operational.alert_raised';
export const OPERATIONAL_ALERT_ACKNOWLEDGED_EVENT = 'operational.alert_acknowledged';

/** Emitted only when `raise()` actually inserted a row — never for a kind/subject that was already open. */
export interface OperationalAlertRaisedEvent {
    id: number;
    kind: OperationalAlertKindEnum;
    severity: OperationalAlertSeverityEnum;
    zoneId: number | null;
    dispatchId: number | null;
    driverId: number | null;
    detail: Record<string, unknown>;
}
