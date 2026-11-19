import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Append-only: an audit event is never updated or deleted (no updated_at). */
@Entity('admin_audit_events')
export class AdminAuditEventEntity {
    @PrimaryColumn({ name: 'admin_audit_event_id', type: 'uuid' })
    id: string;

    @Column({ name: 'actor_user_id', type: 'int', nullable: true })
    actorUserId: number | null;

    @Column({ name: 'actor_role', type: 'varchar', length: 30, nullable: true })
    actorRole: string | null;

    @Column({ name: 'action', type: 'varchar', length: 100 })
    action: string;

    @Column({ name: 'entity_type', type: 'varchar', length: 50, nullable: true })
    entityType: string | null;

    @Column({ name: 'entity_id', type: 'varchar', length: 64, nullable: true })
    entityId: string | null;

    // success | denied | failed
    @Column({ name: 'result', type: 'varchar', length: 20 })
    result: string;

    @Column({ name: 'status_code', type: 'smallint', nullable: true })
    statusCode: number | null;

    @Column({ name: 'correlation_id', type: 'varchar', length: 64 })
    correlationId: string;

    @Column({ name: 'ip_address', type: 'inet', nullable: true })
    ipAddress: string | null;

    @Column({ name: 'metadata', type: 'jsonb', default: () => "'{}'" })
    metadata: Record<string, string | number | boolean | null>;

    @Column({ name: 'occurred_at', type: 'timestamptz' })
    occurredAt: Date;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()', insert: false })
    createdAt: Date;
}
