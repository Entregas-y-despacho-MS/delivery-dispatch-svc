import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';

// PK is a client-generated UUID (v7) — same reasoning as DispatchIncident, see that file's
// comment. NestJS gotcha: pass `version: '7'` explicitly to ParseUUIDPipe/@IsUUID().
@Entity('delivery_evidences')
export class DeliveryEvidence extends BaseCreatedUpdated {
    @PrimaryColumn({ name: 'delivery_evidence_id', type: 'uuid' })
    id: string;

    @Column({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    // photo | signature | otp
    @Column({ name: 'type', type: 'varchar', length: 20 })
    type: string;

    // Already compressed by the app before sending.
    @Column({ name: 'file_url', type: 'text', nullable: true })
    fileUrl: string | null;

    @Column({ name: 'otp_code', type: 'varchar', length: 10, nullable: true })
    otpCode: string | null;

    @ManyToOne(() => Dispatch)
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;
}
