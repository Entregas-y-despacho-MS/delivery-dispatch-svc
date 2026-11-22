import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { ComplaintAffectedItem } from '../domain/complaint-message.types.js';

export type ComplaintIntakeStatus = 'received' | 'acknowledged';

/** Migration 032 (ST-45.1): `received` → `assigned` → `in_investigation` → `decided`. */
export type ComplaintInvestigationStatus = 'received' | 'assigned' | 'in_investigation' | 'decided';

/** The only verdicts a case accepts (RF-U22). `request_RMA` asks Inventory to authorize a return. */
export type ComplaintVerdict = 'no_return_required' | 'request_RMA' | 'not_confirmed';

/**
 * Migration 030 (ST-298.2): inbox + case of a CRM complaint about a delivered dispatch. One row per
 * `(source, crm_case_id)`; a higher `case_version` updates it. Migration 032 (ST-45.1) adds the
 * investigation and the RMA correlation. `updated_at` is kept by a database trigger.
 */
@Entity('delivery_complaint_cases')
export class DeliveryComplaintCase {
    @PrimaryGeneratedColumn({ name: 'delivery_complaint_case_id' })
    id: number;

    @Column({ name: 'message_id', type: 'uuid' })
    messageId: string;

    @Column({ name: 'source', type: 'varchar', length: 100 })
    source: string;

    @Column({ name: 'crm_case_id', type: 'varchar', length: 64 })
    crmCaseId: string;

    @Column({ name: 'case_version', type: 'int' })
    caseVersion: number;

    @Column({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    @Column({ name: 'tracking_code', type: 'varchar', length: 20, nullable: true })
    trackingCode: string | null;

    @Column({ name: 'reason_code', type: 'varchar', length: 40 })
    reasonCode: string;

    @Column({ name: 'affected_items', type: 'jsonb' })
    affectedItems: ComplaintAffectedItem[];

    @Column({ name: 'opened_at', type: 'timestamptz' })
    openedAt: Date;

    @Column({ name: 'intake_status', type: 'varchar', length: 20, default: 'received' })
    intakeStatus: ComplaintIntakeStatus;

    @Column({ name: 'consumed_at', type: 'timestamptz', default: () => 'NOW()' })
    consumedAt: Date;

    @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
    acknowledgedAt: Date | null;

    @Column({ name: 'investigation_status', type: 'varchar', length: 20, default: 'received' })
    investigationStatus: ComplaintInvestigationStatus;

    @Column({ name: 'assigned_user_id', type: 'int', nullable: true })
    assignedUserId: number | null;

    @Column({ name: 'assigned_at', type: 'timestamptz', nullable: true })
    assignedAt: Date | null;

    @Column({ name: 'investigation_started_at', type: 'timestamptz', nullable: true })
    investigationStartedAt: Date | null;

    @Column({ name: 'verdict', type: 'varchar', length: 30, nullable: true })
    verdict: ComplaintVerdict | null;

    @Column({ name: 'decision_reason', type: 'varchar', length: 500, nullable: true })
    decisionReason: string | null;

    @Column({ name: 'findings', type: 'text', nullable: true })
    findings: string | null;

    @Column({ name: 'decided_by_user_id', type: 'int', nullable: true })
    decidedByUserId: number | null;

    @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
    decidedAt: Date | null;

    @Column({ name: 'authorization_request_id', type: 'varchar', length: 100, nullable: true })
    authorizationRequestId: string | null;

    @Column({ name: 'rma_id', type: 'varchar', length: 100, nullable: true })
    rmaId: string | null;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
    createdAt: Date;

    @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'NOW()' })
    updatedAt: Date;
}
