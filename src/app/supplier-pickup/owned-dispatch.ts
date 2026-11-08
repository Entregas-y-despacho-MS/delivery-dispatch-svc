import { ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DispatchNotFoundException } from '../../modules/dispatch/dispatches/exceptions/dispatch-not-found.exception.js';

export interface OwnedDispatchRow {
    dispatch_id: number;
    route_batch_id: number | null;
    dispatch_type: string;
    status: string;
    tracking_code: string | null;
    source_order_ref: string;
    custody_received_at: Date | null;
    arrived_at_warehouse_at: Date | null;
}

interface DispatchIdentity { route_batch_id: number | null; }
interface RouteIdentity { route_batch_id: number; driver_id: number | null; }

/**
 * Locks the route batch and the dispatch (in that order) and checks that the dispatch belongs to the
 * driver's route. Shared by the supplier pickup (ST-239.2) and the customer return pickup (ST-80.2).
 */
export async function loadOwnedDispatch(manager: EntityManager, dispatchId: number, driverId: number): Promise<OwnedDispatchRow> {
    const [identity]: DispatchIdentity[] = await manager.query('SELECT route_batch_id FROM dispatches WHERE dispatch_id = $1', [dispatchId]);
    if (!identity) throw new DispatchNotFoundException();
    if (identity.route_batch_id === null) throw new ForbiddenException({ message: 'Dispatch is not assigned to your route.', error: 'INSUFFICIENT_PERMISSIONS' });

    const [route]: RouteIdentity[] = await manager.query(
        'SELECT route_batch_id, driver_id FROM route_batches WHERE route_batch_id = $1 FOR UPDATE',
        [identity.route_batch_id],
    );
    const [dispatch]: OwnedDispatchRow[] = await manager.query(
        `SELECT d.dispatch_id, d.route_batch_id, t.name AS dispatch_type, ds.name AS status,
                d.tracking_code, d.source_order_ref, d.custody_received_at, d.arrived_at_warehouse_at
           FROM dispatches d
           JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
           JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
          WHERE d.dispatch_id = $1
          FOR UPDATE OF d`,
        [dispatchId],
    );
    if (!dispatch) throw new DispatchNotFoundException();
    if (!route || route.driver_id !== driverId || route.route_batch_id !== identity.route_batch_id || dispatch.route_batch_id !== route.route_batch_id) {
        throw new ForbiddenException({ message: 'Dispatch is not assigned to your route.', error: 'INSUFFICIENT_PERMISSIONS' });
    }
    return dispatch;
}
