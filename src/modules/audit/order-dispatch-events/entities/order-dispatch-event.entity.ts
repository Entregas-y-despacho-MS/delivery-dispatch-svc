import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Append-only history of the business events of an order and its dispatch (RF-A36). Never updated or deleted
 * (no updated_at): the table rejects UPDATE/DELETE with triggers and the app role only has SELECT and INSERT.
 */
@Entity('order_dispatch_events')
export class OrderDispatchEventEntity {
    @PrimaryColumn({ name: 'order_dispatch_event_id', type: 'uuid' })
    id: string;

    @Column({ name: 'source_order_ref', type: 'varchar', length: 100 })
    sourceOrderRef: string;

    @Column({ name: 'dispatch_id', type: 'int', nullable: true })
    dispatchId: number | null;

    @Column({ name: 'route_batch_id', type: 'int', nullable: true })
    routeBatchId: number | null;

    @Column({ name: 'actor_user_id', type: 'int', nullable: true })
    actorUserId: number | null;

    @Column({ name: 'actor_role', type: 'varchar', length: 30, nullable: true })
    actorRole: string | null;

    @Column({ name: 'action', type: 'varchar', length: 100 })
    action: string;

    @Column({ name: 'previous_status', type: 'varchar', length: 50, nullable: true })
    previousStatus: string | null;

    @Column({ name: 'new_status', type: 'varchar', length: 50, nullable: true })
    newStatus: string | null;

    // success | denied | failed
    @Column({ name: 'result', type: 'varchar', length: 20 })
    result: string;

    @Column({ name: 'correlation_id', type: 'varchar', length: 64 })
    correlationId: string;

    @Column({ name: 'detail', type: 'jsonb', default: () => "'{}'" })
    detail: Record<string, string | number | boolean | null>;

    @Column({ name: 'occurred_at', type: 'timestamptz' })
    occurredAt: Date;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()', insert: false })
    createdAt: Date;
}
