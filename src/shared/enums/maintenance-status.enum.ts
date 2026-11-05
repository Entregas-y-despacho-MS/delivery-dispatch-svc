// Must match the values accepted by vehicle_maintenances.status (delivery-dispatch-db/schema/fleet/vehicle_maintenances).
export enum MaintenanceStatusEnum {
    PENDING     = 'pending',
    IN_PROGRESS = 'in_progress',
    COMPLETED   = 'completed',
}
