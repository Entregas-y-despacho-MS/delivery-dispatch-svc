import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';

// RF-A33 — catalog of reschedule/reassignment reasons (e.g. "solicitud expresa del cliente"),
// managed by the dispatch coordinator and the operations supervisor. `category` records who/what
// the delay is attributed to; a `client`-categorized reason is what keeps a reschedule from
// counting against the team's internal punctuality metric (computed wherever dispatch_reschedules
// is eventually written, not in this catalog).
@Entity('reschedule_reasons')
export class RescheduleReason extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'reschedule_reason_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 150 })
    name: string;

    @Column({ name: 'description', type: 'varchar', length: 255, nullable: true })
    description: string | null;

    @Column({ name: 'category', type: 'varchar', length: 20 })
    category: string;

    @Column({ name: 'active', type: 'boolean', default: true })
    active: boolean;
}
