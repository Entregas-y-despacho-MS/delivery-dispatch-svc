import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { RouteBatch } from '../entities/route-batch.entity.js';
import { RouteBatchEvent } from '../entities/route-batch-event.entity.js';
import { RouteBatchNotFoundException, RouteBatchNotProvisionalException, RouteBatchReviewerNotEligibleException } from '../exceptions/index.js';
import { RouteBatchReviewerDto } from '../dto/route-batch-reviewer.dto.js';
import { RoleEnum, RouteBatchStatusEnum } from '../../../../shared/enums/index.js';

export const REVIEWER_ASSIGNED_EVENT   = 'reviewer_assigned';
export const REVIEWER_REASSIGNED_EVENT = 'reviewer_reassigned';
export const REVIEWER_UNASSIGNED_EVENT = 'reviewer_unassigned';

// Serializes every "who reviews this batch?" decision: two batches created at once must see each other's count.
const REVIEWER_BALANCE_LOCK = 'route-batch-reviewer-balance';

// Who may hold a batch under review: the least-loaded pick is coordinators only, but a supervisor who was
// handed a batch by hand keeps it.
const REVIEWER_ROLES: string[] = [RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR];

/** SQL predicate: `userColumn` is an active, not deleted user whose role is in the array bound to `rolesParam`. */
const REVIEWER_ELIGIBLE_SQL = (userColumn: string, rolesParam: string): string =>
    `EXISTS (SELECT 1 FROM users ru JOIN roles rr ON rr.role_id = ru.role_id
              WHERE ru.user_id = ${userColumn} AND ru.active = TRUE AND ru.deleted_at IS NULL AND rr.name = ANY(${rolesParam}))`;

export interface ReviewerAssignment {
    routeBatchId:   number;
    reviewerUserId: number | null;
    /** false when nothing was written (the batch already had a reviewer, or there is nobody to assign). */
    changed:        boolean;
}

@Injectable()
export class RouteBatchReviewerService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**
     * D-42 — gives a freshly created provisional batch, whole, to the active coordinator with the fewest
     * provisional batches under review (ties: lowest user id). With no active coordinator the batch stays
     * without reviewer and visible to everyone; either outcome is written to `route_batch_events` as `system`.
     * A batch that already has a reviewer is left alone. Pass `manager` to join the planner's transaction.
     */
    async assignReviewer(routeBatchId: number, options?: { manager?: EntityManager }): Promise<ReviewerAssignment> {
        if (options?.manager) return await this.assign(options.manager, routeBatchId);
        return await this.dataSource.transaction((manager) => this.assign(manager, routeBatchId));
    }

    /**
     * D-42 — gives every provisional batch whose reviewer stopped being an active coordinator or supervisor
     * (deactivated, deleted, moved to another role) to the least loaded active coordinator, whole; with none
     * available the batch is left without reviewer, visible to everyone. Idempotent: it re-reads the state, so
     * it is safe to run from the user-change listener and, later, from the scheduler as a safety net. Batches are
     * handled oldest first, each in its own transaction, so the balance sees the previous hand-overs.
     */
    async reassignFromIneligibleReviewers(trigger = 'reviewer_inactive'): Promise<ReviewerAssignment[]> {
        const rows: { id: number }[] = await this.dataSource.query(
            `SELECT b.route_batch_id AS id
               FROM route_batches b
              WHERE b.status = $1 AND b.reviewer_user_id IS NOT NULL
                AND NOT ${REVIEWER_ELIGIBLE_SQL('b.reviewer_user_id', '$2')}
              ORDER BY b.route_batch_id`,
            [RouteBatchStatusEnum.PROVISIONAL, REVIEWER_ROLES],
        );

        const results: ReviewerAssignment[] = [];
        for (const { id } of rows) {
            const result = await this.dataSource.transaction((manager) => this.reassignIneligible(manager, id, trigger));
            if (result) results.push(result);
        }
        return results;
    }

    private async reassignIneligible(manager: EntityManager, routeBatchId: number, trigger: string): Promise<ReviewerAssignment | null> {
        const [batch]: { reviewer_user_id: number | null; status: string; eligible: boolean }[] = await manager.query(
            `SELECT b.reviewer_user_id, b.status, ${REVIEWER_ELIGIBLE_SQL('b.reviewer_user_id', '$2')} AS eligible
               FROM route_batches b
              WHERE b.route_batch_id = $1
                FOR UPDATE OF b`,
            [routeBatchId, REVIEWER_ROLES],
        );
        // Someone fixed it between the scan and the lock (manual hand-over, approval...): nothing to do.
        if (!batch || batch.status !== RouteBatchStatusEnum.PROVISIONAL || batch.reviewer_user_id === null || batch.eligible) return null;

        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [REVIEWER_BALANCE_LOCK]);
        const picked = await this.pickLeastLoadedCoordinator(manager);
        const events = manager.getRepository(RouteBatchEvent);

        if (!picked) {
            await manager.getRepository(RouteBatch).update(routeBatchId, { reviewerUserId: null });
            await events.save(events.create({
                routeBatchId, eventType: REVIEWER_UNASSIGNED_EVENT, actorUserId: null, actorType: 'system',
                reason: 'No active coordinators.',
                metadata: { from: batch.reviewer_user_id, reason: 'no_active_coordinators', mode: 'automatic', trigger },
            }));
            return { routeBatchId, reviewerUserId: null, changed: true };
        }

        await manager.getRepository(RouteBatch).update(routeBatchId, { reviewerUserId: picked.id });
        await events.save(events.create({
            routeBatchId, eventType: REVIEWER_REASSIGNED_EVENT, actorUserId: null, actorType: 'system',
            reason: 'The reviewer is no longer an active coordinator or supervisor.',
            metadata: { from: batch.reviewer_user_id, to: picked.id, pendingBatches: picked.pending, mode: 'automatic', trigger },
        }));
        return { routeBatchId, reviewerUserId: picked.id, changed: true };
    }

    /**
     * Manual handover of the whole batch to another coordinator or supervisor (D-42). The target must be an
     * active, not deleted coordinator or supervisor. Asking for the current reviewer is a no-op (no write, no
     * event). The batch `version` is not touched: it only moves on approve, move, merge and freeze (§5.2).
     */
    async reassignReviewer(routeBatchId: number, reviewerUserId: number, actorUserId: number, reason?: string | null): Promise<RouteBatchReviewerDto> {
        return await this.dataSource.transaction(async (manager) => {
            const [batch]: { reviewer_user_id: number | null; status: string; version: number }[] = await manager.query(
                `SELECT reviewer_user_id, status, version FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
                [routeBatchId],
            );
            if (!batch) throw new RouteBatchNotFoundException();
            if (batch.status !== RouteBatchStatusEnum.PROVISIONAL) throw new RouteBatchNotProvisionalException(batch.status);

            const result = { id: routeBatchId, status: batch.status, reviewerUserId, version: batch.version };
            if (batch.reviewer_user_id === reviewerUserId) return result;

            const eligible = await manager.query(
                `SELECT 1
                   FROM users u
                   JOIN roles r ON r.role_id = u.role_id
                  WHERE u.user_id = $1 AND u.active = TRUE AND u.deleted_at IS NULL AND r.name = ANY($2)`,
                [reviewerUserId, [RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR]],
            );
            if (eligible.length === 0) throw new RouteBatchReviewerNotEligibleException();

            await manager.getRepository(RouteBatch).update(routeBatchId, { reviewerUserId });
            const events = manager.getRepository(RouteBatchEvent);
            await events.save(events.create({
                routeBatchId, eventType: REVIEWER_REASSIGNED_EVENT, actorUserId, actorType: 'user',
                reason: reason ?? null, metadata: { from: batch.reviewer_user_id, to: reviewerUserId, mode: 'manual' },
            }));
            return result;
        });
    }

    /** Active, not deleted coordinator with the fewest `provisional` batches assigned; ties → lowest id. */
    async pickLeastLoadedCoordinator(manager: EntityManager): Promise<{ id: number; pending: number } | null> {
        const [row]: { id: number; pending: string }[] = await manager.query(
            `SELECT u.user_id AS id, COUNT(b.route_batch_id) AS pending
               FROM users u
               JOIN roles r ON r.role_id = u.role_id
          LEFT JOIN route_batches b ON b.reviewer_user_id = u.user_id AND b.status = $2
              WHERE r.name = $1 AND u.active = TRUE AND u.deleted_at IS NULL
           GROUP BY u.user_id
           ORDER BY COUNT(b.route_batch_id) ASC, u.user_id ASC
              LIMIT 1`,
            [RoleEnum.COORDINATOR, RouteBatchStatusEnum.PROVISIONAL],
        );
        return row ? { id: row.id, pending: Number(row.pending) } : null;
    }

    private async assign(manager: EntityManager, routeBatchId: number): Promise<ReviewerAssignment> {
        const [batch]: { reviewer_user_id: number | null; status: string }[] = await manager.query(
            `SELECT reviewer_user_id, status FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
            [routeBatchId],
        );
        if (!batch) throw new RouteBatchNotFoundException();
        if (batch.status !== RouteBatchStatusEnum.PROVISIONAL) throw new RouteBatchNotProvisionalException(batch.status);
        if (batch.reviewer_user_id !== null) return { routeBatchId, reviewerUserId: batch.reviewer_user_id, changed: false };

        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [REVIEWER_BALANCE_LOCK]);
        const picked = await this.pickLeastLoadedCoordinator(manager);

        const events = manager.getRepository(RouteBatchEvent);
        if (!picked) {
            await events.save(events.create({
                routeBatchId, eventType: REVIEWER_UNASSIGNED_EVENT, actorUserId: null, actorType: 'system',
                reason: 'No active coordinators.', metadata: { reason: 'no_active_coordinators' },
            }));
            return { routeBatchId, reviewerUserId: null, changed: false };
        }

        await manager.getRepository(RouteBatch).update(routeBatchId, { reviewerUserId: picked.id });
        await events.save(events.create({
            routeBatchId, eventType: REVIEWER_ASSIGNED_EVENT, actorUserId: null, actorType: 'system',
            metadata: { to: picked.id, pendingBatches: picked.pending, mode: 'automatic', trigger: 'batch_created' },
        }));
        return { routeBatchId, reviewerUserId: picked.id, changed: true };
    }
}
