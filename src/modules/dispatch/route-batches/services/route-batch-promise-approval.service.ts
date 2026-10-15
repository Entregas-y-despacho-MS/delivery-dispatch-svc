import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { DispatchStatusEnum, RouteBatchStatusEnum } from '../../../../shared/enums/index.js';
import { MailerPort } from '../../../../plugins/mailer/mailer.port.js';
import { ApproveRouteBatchPromisesDto } from '../dto/approve-route-batch-promises.dto.js';
import { ApproveRouteBatchPromisesResponseDto, PromiseEmailResultDto } from '../dto/approve-route-batch-promises-response.dto.js';
import { RouteBatchApprovalConflictException, RouteBatchNotFoundException, RouteBatchNotProvisionalException, RouteBatchReviewerMismatchException } from '../exceptions/index.js';
import { RouteCapacityService } from './route-capacity.service.js';

interface BatchRow {
    id: number;
    version: number;
    status: string;
    reviewer_user_id: number | null;
    vehicle_id: number | null;
}

interface DispatchRow {
    id: number;
    version: number;
    status: string;
    contact_email: string | null;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
    tracking_token: string | null;
    promise_notified_at: Date | null;
}

interface ApprovalPlan {
    routeBatchId: number;
    version: number;
    approved: DispatchRow[];
    removed: DispatchRow[];
    actorUserId: number;
}

@Injectable()
export class RouteBatchPromiseApprovalService {
    private readonly webUrl: string;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly capacity: RouteCapacityService,
        private readonly mailer: MailerPort,
        config: ConfigService,
    ) {
        this.webUrl = config.get<string>('PUBLIC_WEB_URL', 'http://localhost:5173')!.replace(/\/$/, '');
    }

    async approve(
        routeBatchId: number,
        dto: ApproveRouteBatchPromisesDto,
        actorUserId: number,
    ): Promise<ApproveRouteBatchPromisesResponseDto> {
        const plan = await this.dataSource.transaction((manager) => this.commitApproval(manager, routeBatchId, dto, actorUserId));
        const emailResults = await this.notifyCustomers(plan);
        return {
            routeBatchId,
            version: plan.version,
            approvedCount: plan.approved.length,
            removedCount: plan.removed.length,
            emailCount: emailResults.filter((result) => result.result !== 'skipped').length,
            emailResults,
        };
    }

    private async commitApproval(
        manager: EntityManager,
        routeBatchId: number,
        dto: ApproveRouteBatchPromisesDto,
        actorUserId: number,
    ): Promise<ApprovalPlan> {
        const [batch]: BatchRow[] = await manager.query(
            `SELECT route_batch_id AS id, version, status, reviewer_user_id, vehicle_id
               FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
            [routeBatchId],
        );
        if (!batch) throw new RouteBatchNotFoundException();
        if (batch.status !== RouteBatchStatusEnum.PROVISIONAL) throw new RouteBatchNotProvisionalException(batch.status);
        if (batch.reviewer_user_id !== null && batch.reviewer_user_id !== actorUserId) throw new RouteBatchReviewerMismatchException();
        if (batch.version !== dto.version) {
            throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VERSION_CONFLICT', 'The route batch changed. Reload it before approving.');
        }
        if (batch.vehicle_id === null) {
            throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VEHICLE_REQUIRED', 'Assign a vehicle before approving promises.');
        }

        const dispatches: DispatchRow[] = await manager.query(
            `SELECT d.dispatch_id AS id, d.version, s.name AS status, d.contact_email,
                    d.scheduled_window_start, d.scheduled_window_end, d.tracking_token, d.promise_notified_at
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.route_batch_id = $1
              ORDER BY d.dispatch_id
              FOR UPDATE OF d`,
            [routeBatchId],
        );
        if (dispatches.length === 0) {
            throw new RouteBatchApprovalConflictException('ROUTE_BATCH_HAS_NO_APPROVALS', 'The route batch has no dispatches to approve.');
        }
        this.assertExpectedDispatchVersions(dispatches, dto);

        const removeIds = new Set(dto.removeDispatchIds ?? []);
        const approved = dispatches.filter((dispatch) => !removeIds.has(dispatch.id));
        const removed = dispatches.filter((dispatch) => removeIds.has(dispatch.id));
        if (approved.length === 0) {
            throw new RouteBatchApprovalConflictException('ROUTE_BATCH_HAS_NO_APPROVALS', 'At least one dispatch must remain in the batch.');
        }
        for (const dispatch of dispatches) {
            if (dispatch.status !== DispatchStatusEnum.IN_PLANNING) {
                throw new RouteBatchApprovalConflictException('DISPATCH_VERSION_CONFLICT', `Dispatch ${dispatch.id} is no longer in planning.`);
            }
        }
        for (const dispatch of removed) await this.removeDispatch(manager, routeBatchId, dispatch, actorUserId);
        await this.capacity.assertAssignable(routeBatchId, batch.vehicle_id, manager);
        for (const dispatch of approved) await this.approveDispatch(manager, routeBatchId, dispatch, actorUserId);
        await manager.query(
            `UPDATE route_batches SET version = version + 1, updated_at = NOW() WHERE route_batch_id = $1`,
            [routeBatchId],
        );
        await manager.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_user_id, actor_type, reason, metadata)
             VALUES ($1, 'promises_approved', $2, 'user', 'Coordinator approved the provisional promises', $3::jsonb)`,
            [routeBatchId, actorUserId, JSON.stringify({ previousVersion: batch.version, version: batch.version + 1, approvedDispatchIds: approved.map(({ id }) => id), removedDispatchIds: removed.map(({ id }) => id) })],
        );
        return { routeBatchId, version: batch.version + 1, approved, removed, actorUserId };
    }

    private assertExpectedDispatchVersions(dispatches: DispatchRow[], dto: ApproveRouteBatchPromisesDto): void {
        const expected = new Map<number, number>();
        for (const item of dto.dispatches) {
            if (expected.has(item.dispatchId)) {
                throw new RouteBatchApprovalConflictException('DISPATCH_VERSION_CONFLICT', `Dispatch ${item.dispatchId} appears more than once.`);
            }
            expected.set(item.dispatchId, item.version);
        }
        if (expected.size !== dispatches.length || dispatches.some((dispatch) => expected.get(dispatch.id) !== dispatch.version)) {
            throw new RouteBatchApprovalConflictException('DISPATCH_VERSION_CONFLICT', 'One or more dispatches changed or are missing from the approval request. Reload the route batch.');
        }
        const actualIds = new Set(dispatches.map(({ id }) => id));
        if ((dto.removeDispatchIds ?? []).some((id) => !actualIds.has(id))) {
            throw new RouteBatchApprovalConflictException('DISPATCH_VERSION_CONFLICT', 'A dispatch selected for removal does not belong to this route batch.');
        }
    }

    private async approveDispatch(manager: EntityManager, routeBatchId: number, dispatch: DispatchRow, actorUserId: number): Promise<void> {
        const token = randomUUID();
        dispatch.tracking_token = token;
        await manager.query(
            `UPDATE dispatches
                SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                    tracking_token = $3, tracking_token_expires_at = NULL, version = version + 1, updated_at = NOW()
              WHERE dispatch_id = $1`,
            [dispatch.id, DispatchStatusEnum.SCHEDULED, token],
        );
        await manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
             VALUES ($1, 'promise_approved', $2, 'user', 'Coordinator approved the delivery promise', $3::jsonb)`,
            [dispatch.id, actorUserId, JSON.stringify({ routeBatchId, previousVersion: dispatch.version, version: dispatch.version + 1, scheduledWindowStart: dispatch.scheduled_window_start, scheduledWindowEnd: dispatch.scheduled_window_end })],
        );
    }

    private async removeDispatch(manager: EntityManager, routeBatchId: number, dispatch: DispatchRow, actorUserId: number): Promise<void> {
        await manager.query(
            `UPDATE dispatches
                SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                    route_batch_id = NULL, sequence_order = NULL, version = version + 1, updated_at = NOW()
              WHERE dispatch_id = $1`,
            [dispatch.id, DispatchStatusEnum.PENDING],
        );
        const metadata = JSON.stringify({ previousVersion: dispatch.version, version: dispatch.version + 1, previousRouteBatchId: routeBatchId });
        await manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
             VALUES ($1, 'removed_from_provisional_batch', $2, 'user', 'Coordinator removed the dispatch before approval', $3::jsonb)`,
            [dispatch.id, actorUserId, metadata],
        );
        await manager.query(
            `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
             VALUES ($1, $2, 'dispatch_removed_before_approval', $3, 'user', 'Dispatch returned to pending before approval', $4::jsonb)`,
            [routeBatchId, dispatch.id, actorUserId, metadata],
        );
    }

    private async notifyCustomers(plan: ApprovalPlan): Promise<PromiseEmailResultDto[]> {
        const results: PromiseEmailResultDto[] = [];
        for (const dispatch of plan.approved) {
            if (!dispatch.contact_email) {
                results.push({ dispatchId: dispatch.id, result: 'skipped' });
                continue;
            }
            let result: 'sent' | 'bounced' | 'failed' = 'failed';
            try {
                const delivery = await this.mailer.send({
                    to: dispatch.contact_email,
                    subject: 'Tu entrega está programada',
                    template: 'promise',
                    context: {
                        deliveryDate: formatDate(dispatch.scheduled_window_start),
                        deliveryWindow: formatWindow(dispatch.scheduled_window_start, dispatch.scheduled_window_end),
                        trackingUrl: `${this.webUrl}/seguimiento/${dispatch.tracking_token}`,
                    },
                    metadata: { dispatchId: dispatch.id, routeBatchId: plan.routeBatchId },
                });
                result = delivery.status;
            } catch {
                result = 'failed';
            }
            if (result === 'sent') await this.recordSuccessfulNotification(plan, dispatch);
            if (result === 'bounced') await this.recordContactCase(plan, dispatch);
            results.push({ dispatchId: dispatch.id, result });
        }
        return results;
    }

    private async recordSuccessfulNotification(plan: ApprovalPlan, dispatch: DispatchRow): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const updated: { dispatch_id: number }[] = await manager.query(
                `UPDATE dispatches
                    SET promise_notified_at = COALESCE(promise_notified_at, NOW()), updated_at = NOW()
                  WHERE dispatch_id = $1 AND route_batch_id = $2 AND version = $3
                    AND dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $4)
                RETURNING dispatch_id`,
                [dispatch.id, plan.routeBatchId, dispatch.version + 1, DispatchStatusEnum.SCHEDULED],
            );
            if (updated.length === 0) return;
            await manager.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
                 VALUES ($1, 'promise_email_sent', $2, 'user', 'Promise email accepted by the configured mail transport', $3::jsonb)`,
                [dispatch.id, plan.actorUserId, JSON.stringify({ routeBatchId: plan.routeBatchId, template: 'promise' })],
            );
        });
    }

    private async recordContactCase(plan: ApprovalPlan, dispatch: DispatchRow): Promise<void> {
        const metadata = JSON.stringify({ category: 'customer_contact', recipient: dispatch.contact_email, template: 'promise', deliveryResult: 'bounced' });
        await this.dataSource.transaction(async (manager) => {
            await manager.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
                 VALUES ($1, 'promise_email_bounced', 'system', 'Customer contact is required after email bounce', $2::jsonb)`,
                [dispatch.id, metadata],
            );
            await manager.query(
                `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_type, reason, metadata)
                 VALUES ($1, $2, 'contact_management_required', 'system', 'Promise email bounced; coordinator must contact the customer', $3::jsonb)`,
                [plan.routeBatchId, dispatch.id, metadata],
            );
        });
    }
}

function formatWindow(start: Date | null, end: Date | null): string {
    if (!start || !end) return '';
    const formatter = new Intl.DateTimeFormat('es-BO', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/La_Paz' });
    return `${formatter.format(start)} – ${formatter.format(end)}`;
}

function formatDate(date: Date | null): string {
    if (!date) return '';
    return new Intl.DateTimeFormat('es-BO', { dateStyle: 'long', timeZone: 'America/La_Paz' }).format(date);
}
