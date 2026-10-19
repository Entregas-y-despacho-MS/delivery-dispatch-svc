export const ROUTE_ASSIGNED_EVENT = 'route.assigned';

export interface RouteAssignedEvent {
  routeId: number;
  driverId: number;
  vehicleId: number;
  dispatchIds: number[];
  dispatches: Array<{ dispatchId: number; priority: string }>;
  zoneName: string;
  version: number;
}
