import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';

// RF-A32 — catalog of incident reasons (e.g. "customer absent"), managed by the logistics
// coordinator and the operations supervisor, consumed offline by the driver's mobile app.
@Entity('incident_reasons')
export class IncidentReason extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'incident_reason_id' })
    id: number;

    @Column({ name: 'code', type: 'varchar', length: 30 })
    code: string;

    @Column({ name: 'name', type: 'varchar', length: 150 })
    name: string;

    @Column({ name: 'requires_evidence', type: 'boolean', default: false })
    requiresEvidence: boolean;

    @Column({ name: 'active', type: 'boolean', default: true })
    active: boolean;
}
