import type { EntityManager } from 'typeorm';

/**
 * Facts about the vehicle and the driver of a batch that the validation of the cutoff (ST-51.3) needs.
 * Shared by the cutoff writer and by the revalidation that follows a correction (ST-51.6), so both ask the
 * same question. `ownBatchIds` are the batches that may legitimately hold the resource (the group of the cutoff,
 * or the corrected batch itself).
 */

/** Another non-cancelled batch holding `vehicleId` on `shiftDate`; `null` when the vehicle is free. */
export async function findVehicleConflict(
    manager: EntityManager,
    vehicleId: number,
    shiftDate: string,
    ownBatchIds: number[],
): Promise<number | null> {
    const [row]: { route_batch_id: number }[] = await manager.query(
        `SELECT route_batch_id FROM route_batches
          WHERE vehicle_id = $1 AND shift_date = $2::date AND status <> 'cancelled'
            AND route_batch_id <> ALL($3::int[])
          LIMIT 1`,
        [vehicleId, shiftDate, ownBatchIds],
    );
    return row?.route_batch_id ?? null;
}

/** Whether `driverId` is still an active driver and which other non-cancelled batch holds them that day. */
export async function findDriverFacts(
    manager: EntityManager,
    driverId: number,
    shiftDate: string,
    ownBatchIds: number[],
): Promise<{ active: boolean; conflictBatchId: number | null }> {
    const [driver]: { user_id: number }[] = await manager.query(
        `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
          WHERE u.user_id = $1 AND u.active = TRUE AND u.deleted_at IS NULL AND r.name = 'driver'`,
        [driverId],
    );
    const [row]: { route_batch_id: number }[] = await manager.query(
        `SELECT route_batch_id FROM route_batches
          WHERE (driver_id = $1 OR proposed_driver_id = $1) AND shift_date = $2::date
            AND status <> 'cancelled' AND route_batch_id <> ALL($3::int[])
          LIMIT 1`,
        [driverId, shiftDate, ownBatchIds],
    );
    return { active: driver !== undefined, conflictBatchId: row?.route_batch_id ?? null };
}
