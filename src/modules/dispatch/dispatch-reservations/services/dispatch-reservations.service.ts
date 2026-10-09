import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../../../settings/services/settings.service.js';
import { INBOX_ELIGIBILITY_SQL } from '../../dispatches/utils/inbox-eligibility.js';
import { DispatchAlreadyReservedException, DispatchNotReservableException } from '../exceptions/index.js';

export const RESERVATION_TTL_SETTING = 'order_reservation_ttl_minutes';
const DEFAULT_TTL_MINUTES = 15;

/**
 * Soft reservation: while a coordinator plans a route with a batch of orders, those orders are held
 * in their name and other coordinators see them blocked. There is no cleanup job: a reservation is
 * live only while `expires_at` is in the future, so an abandoned one simply stops counting and the
 * next coordinator's reserve replaces the row.
 */
@Injectable()
export class DispatchReservationsService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly settings: SettingsService,
    ) {}

    private ttlMinutes(): number {
        const ttl = Math.trunc(this.settings.getNumber(RESERVATION_TTL_SETTING, DEFAULT_TTL_MINUTES));
        return ttl >= 1 ? ttl : DEFAULT_TTL_MINUTES;
    }

    /** All-or-nothing: if any order cannot be reserved, none is. Re-reserving your own orders renews them. */
    async reserve(userId: number, dispatchIds: number[]): Promise<{ reserved: number; expiresAt: Date }> {
        const ttl = this.ttlMinutes();
        return this.dataSource.transaction(async (manager) => {
            const eligible: { id: number }[] = await manager.query(
                `SELECT d.dispatch_id AS id
                   FROM dispatches d JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
                  WHERE d.dispatch_id = ANY($1::int[]) AND ${INBOX_ELIGIBILITY_SQL}`,
                [dispatchIds],
            );
            const eligibleIds = new Set(eligible.map((r) => Number(r.id)));
            const notReservable = dispatchIds.filter((id) => !eligibleIds.has(id));
            if (notReservable.length) throw new DispatchNotReservableException(notReservable);

            // The WHERE on the conflict branch is what keeps another coordinator's live reservation untouched.
            const rows: { dispatch_id: number; expires_at: Date }[] = await manager.query(
                `INSERT INTO dispatch_reservations (dispatch_id, reserved_by, reserved_at, last_activity_at, expires_at)
                 SELECT unnest($1::int[]), $2, NOW(), NOW(), NOW() + make_interval(mins => $3::int)
                 ON CONFLICT (dispatch_id) DO UPDATE SET
                        reserved_by      = EXCLUDED.reserved_by,
                        reserved_at      = CASE WHEN dispatch_reservations.reserved_by = EXCLUDED.reserved_by
                                                 AND dispatch_reservations.expires_at > NOW()
                                                THEN dispatch_reservations.reserved_at ELSE NOW() END,
                        last_activity_at = NOW(),
                        expires_at       = EXCLUDED.expires_at
                  WHERE dispatch_reservations.reserved_by = EXCLUDED.reserved_by
                     OR dispatch_reservations.expires_at <= NOW()
              RETURNING dispatch_id, expires_at`,
                [dispatchIds, userId, ttl],
            );
            const done = new Set(rows.map((r) => Number(r.dispatch_id)));
            const taken = dispatchIds.filter((id) => !done.has(id));
            // Thrown inside the transaction, so the ones that did go through are rolled back.
            if (taken.length) throw new DispatchAlreadyReservedException(taken);

            return { reserved: rows.length, expiresAt: new Date(rows[0].expires_at) };
        });
    }

    /** Coordinator activity: pushes the expiry of every live reservation they hold. */
    async renew(userId: number): Promise<{ renewed: number; expiresAt: Date | null }> {
        // TypeORM answers UPDATE/DELETE ... RETURNING on Postgres as [rows, affectedCount], unlike a SELECT or INSERT.
        const [rows]: [{ expires_at: Date }[], number] = await this.dataSource.query(
            `UPDATE dispatch_reservations
                SET last_activity_at = NOW(), expires_at = NOW() + make_interval(mins => $2::int)
              WHERE reserved_by = $1 AND expires_at > NOW()
          RETURNING expires_at`,
            [userId, this.ttlMinutes()],
        );
        return { renewed: rows.length, expiresAt: rows.length ? new Date(rows[0].expires_at) : null };
    }

    /**
     * Confirming or cancelling the planning. Only releases the caller's own reservations; without
     * IDs it releases all of them. Also callable by the route-planning code when it confirms a route.
     */
    async release(userId: number, dispatchIds?: number[]): Promise<{ released: number }> {
        const [rows]: [unknown[], number] = await this.dataSource.query(
            `DELETE FROM dispatch_reservations
              WHERE reserved_by = $1 AND ($2::int[] IS NULL OR dispatch_id = ANY($2::int[]))
          RETURNING dispatch_id`,
            [userId, dispatchIds ?? null],
        );
        return { released: rows.length };
    }
}
