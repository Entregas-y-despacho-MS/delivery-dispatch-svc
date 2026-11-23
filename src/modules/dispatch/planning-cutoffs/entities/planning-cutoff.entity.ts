import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreated } from '../../../../database/entities/base.entity.js';

export type PlanningCutoffTrigger = 'scheduled' | 'manual';

/**
 * ST-302.2 (ES-302): one run of the D-1 cutoff that left a snapshot of its planning universe.
 * Append-only history; the database rejects UPDATE and restricts DELETE.
 */
@Entity('planning_cutoffs')
export class PlanningCutoff extends BaseCreated {
    @PrimaryGeneratedColumn({ name: 'planning_cutoff_id' })
    id: number;

    /** Operating day of the routes the cutoff plans (`YYYY-MM-DD`). */
    @Column({ name: 'shift_date', type: 'date' })
    shiftDate: string;

    /** UTC instant of the cutoff: when the run started. */
    @Column({ name: 'cutoff_at', type: 'timestamptz' })
    cutoffAt: Date;

    @Column({ name: 'operating_timezone', type: 'varchar', length: 40 })
    operatingTimezone: string;

    @Column({ name: 'trigger_type', type: 'varchar', length: 20 })
    triggerType: PlanningCutoffTrigger;

    /** `route-cutoff@YYYY-MM-DDTHH:mm`; `null` for a manual run. Unique, so a repeated occurrence never rewrites the snapshot. */
    @Column({ name: 'occurrence', type: 'varchar', length: 60, nullable: true })
    occurrence: string | null;
}
