// Must match vehicle_statuses.name exactly (delivery-dispatch-db/schema/fleet/vehicle_statuses/data.sql).
export enum VehicleStatusEnum {
    ACTIVE         = 'active',
    MAINTENANCE    = 'maintenance',
    OUT_OF_SERVICE = 'out_of_service',
}
