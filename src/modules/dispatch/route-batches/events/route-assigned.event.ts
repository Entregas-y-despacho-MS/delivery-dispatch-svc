export const ROUTE_ASSIGNED_EVENT = 'route.assigned';

export interface RouteAssignedEvent {
  routeId: number;
  driverId: number;
  vehicleId: number;
  dispatchIds: number[];
  dispatches: Array<{ dispatchId: number; priority: string }>;
  zoneName: string;
  version: number;
  /**
   * Set only by `RouteBatchReassignmentService` (ES-63): this is a board/socket refresh of a batch
   * that was already `in_execution`, not a real final approval. Listeners whose work only makes
   * sense for a genuine new assignment check this and return early — `RouteAssignedPushListener`
   * (its own `notifyReassigned` already covers the push for this case, so `notify` would otherwise
   * send a second, and for the origin side misleading, "new route" push) and
   * `LateApprovalNoticeListener` (an `in_execution` batch is never `confirmed`, so it always does
   * nothing here anyway — this just skips the wasted settings load and batch query to get there).
   */
  fromReassignment?: boolean;
}
