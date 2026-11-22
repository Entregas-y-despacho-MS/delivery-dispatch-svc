import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { normalizeCorrelationId, redactMetadata } from '../../admin-audit-events/domain/admin-audit-event.js';
import { currentCorrelationId } from '../context/correlation-context.js';
import type { OrderDispatchAction } from '../domain/order-dispatch-event-actions.js';
import { OrderDispatchEventEntity } from '../entities/order-dispatch-event.entity.js';

export interface RecordOrderDispatchEventData {
    sourceOrderRef: string;
    dispatchId?: number | null;
    routeBatchId?: number | null;
    /** `null`/omitted: the system originated it (role `system`). Without `role`, it is read from the user's row. */
    actor?: { id: number; role?: string } | null;
    action: OrderDispatchAction;
    previousStatus?: string | null;
    newStatus?: string | null;
    /** Defaults to the id of the request being served, or a new UUID outside HTTP (consumers, scheduled tasks). */
    correlationId?: string | null;
    detail?: Record<string, unknown>;
    /** When the fact happened (a device may sync late); defaults to now. */
    occurredAt?: Date;
}

export type RecordForDispatchData = Omit<RecordOrderDispatchEventData, 'sourceOrderRef' | 'dispatchId' | 'routeBatchId'> & { routeBatchId?: number | null };

/**
 * Business history of orders and dispatches (RF-A36). Unlike the admin audit (RF-A35), writing here is part of the
 * command: every write needs the caller's `EntityManager`, so the event and the state change commit or roll back
 * together, and a failed insert is NOT caught — it fails the command. Append and read only.
 */
@Injectable()
export class OrderDispatchEventsService {
    constructor(
        @InjectRepository(OrderDispatchEventEntity) private readonly repo: Repository<OrderDispatchEventEntity>,
    ) {}

    /** Inserts the event inside the caller's transaction. Throws if it cannot be stored. */
    async record(data: RecordOrderDispatchEventData, options: { manager: EntityManager }): Promise<string> {
        const id = randomUUID();
        const actorRole = data.actor ? (data.actor.role ?? (await this.roleOf(data.actor.id, options.manager))) : 'system';
        await options.manager.getRepository(OrderDispatchEventEntity).insert({
            id,
            sourceOrderRef: data.sourceOrderRef,
            dispatchId: data.dispatchId ?? null,
            routeBatchId: data.routeBatchId ?? null,
            actorUserId: data.actor?.id ?? null,
            actorRole,
            action: data.action,
            previousStatus: data.previousStatus ?? null,
            newStatus: data.newStatus ?? null,
            result: 'success',
            correlationId: normalizeCorrelationId(data.correlationId) ?? currentCorrelationId() ?? randomUUID(),
            detail: redactMetadata(data.detail),
            occurredAt: data.occurredAt ?? new Date(),
        });
        return id;
    }

    private async roleOf(userId: number, manager: EntityManager): Promise<string | null> {
        const [row]: { name: string }[] = await manager.query(
            'SELECT r.name FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1',
            [userId],
        );
        return row?.name ?? null;
    }

    /**
     * Same as `record` for a dispatch that already exists: the order reference and, unless given, the batch are read
     * from the dispatch row in the same transaction, so a dispatch→order→batch link is always the stored one.
     */
    async recordForDispatch(dispatchId: number, data: RecordForDispatchData, options: { manager: EntityManager }): Promise<string> {
        const [row]: { source_order_ref: string; route_batch_id: number | null }[] = await options.manager.query(
            'SELECT source_order_ref, route_batch_id FROM dispatches WHERE dispatch_id = $1',
            [dispatchId],
        );
        if (!row) throw new Error(`Cannot record an order/dispatch event: dispatch ${dispatchId} does not exist`);
        return this.record({
            ...data,
            sourceOrderRef: row.source_order_ref,
            dispatchId,
            routeBatchId: data.routeBatchId === undefined ? row.route_batch_id : data.routeBatchId,
        }, options);
    }

    /** The sequence of a dispatch, oldest first; a read, it never mutates. */
    findByDispatch(dispatchId: number): Promise<OrderDispatchEventEntity[]> {
        return this.repo.find({ where: { dispatchId }, order: { occurredAt: 'ASC', createdAt: 'ASC', id: 'ASC' } });
    }

    /** The sequence of an order across all its dispatches, oldest first. */
    findByOrder(sourceOrderRef: string): Promise<OrderDispatchEventEntity[]> {
        return this.repo.find({ where: { sourceOrderRef }, order: { occurredAt: 'ASC', createdAt: 'ASC', id: 'ASC' } });
    }
}
