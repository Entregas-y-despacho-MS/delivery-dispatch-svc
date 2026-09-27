// Must match the `chk_reschedule_reasons_category` CHECK constraint on reschedule_reasons.category
// exactly (delivery-dispatch-db/schema/catalog/reschedule_reasons/create.sql) — a plain CHECK'd
// column, not a lookup table, unlike VehicleStatusEnum/DispatchStatusEnum.
export enum RescheduleReasonCategoryEnum {
    CLIENT        = 'client',
    OPERATIONS    = 'operations',
    FORCE_MAJEURE = 'force_majeure',
}
