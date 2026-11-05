export const ROUTE_VEHICLE_CHANGED_EVENT = 'route.vehicle_changed';

export interface RouteVehicleChangedEvent {
  routeId: number;
  driverId: number | null;
  vehicleId: number;
  vehiclePlate: string;
  zoneName: string | null;
  version: number;
  acceptanceRevoked: boolean;
}
