// Must match the CHECK constraints of operational_alerts (delivery-dispatch-db migration 026).
export enum OperationalAlertKindEnum {
    CRITICAL_INCIDENT  = 'critical_incident',
    GPS_STALE          = 'gps_stale',
    DRIVER_INCIDENTS   = 'driver_incidents',
    SLA_BELOW_THRESHOLD = 'sla_below_threshold',
}

export enum OperationalAlertSeverityEnum {
    CRITICAL = 'critical',
    WARNING  = 'warning',
}

export enum OperationalAlertStatusEnum {
    OPEN         = 'open',
    ACKNOWLEDGED = 'acknowledged',
}
