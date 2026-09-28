// Must match the `chk_vehicle_incident_types_severity` CHECK constraint on
// vehicle_incident_types.severity exactly (delivery-dispatch-db/schema/fleet/vehicle_incident_types/create.sql)
// — a plain CHECK'd column, not a lookup table, like RescheduleReasonCategoryEnum.
export enum VehicleIncidentSeverityEnum {
    MINOR    = 'minor',
    MODERATE = 'moderate',
    CRITICAL = 'critical',
}
