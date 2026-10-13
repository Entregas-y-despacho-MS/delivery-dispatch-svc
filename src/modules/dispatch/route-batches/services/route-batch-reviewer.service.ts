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
