import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';
import { IncidentReason } from '../../../catalog/incident-reasons/entities/incident-reason.entity.js';

// PK is a client-generated UUID (v7, not v4 — see create.sql), not SERIAL: the driver's mobile
// app creates this record while offline, before syncing. @PrimaryColumn, not
// @PrimaryGeneratedColumn — there is no DB-side default to generate it.
// NestJS gotcha: ParseUUIDPipe/@IsUUID() reject v7 unless `version: '7'` is passed explicitly.
@Entity('dispatch_incidents')
export class DispatchIncident extends BaseCreatedUpdated {
    @PrimaryColumn({ name: 'dispatch_incident_id', type: 'uuid' })
    id: string;

    @Column({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    @Column({ name: 'incident_reason_id', type: 'int' })
    incidentReasonId: number;

    @Column({ name: 'description', type: 'text', nullable: true })
    description: string | null;

    @ManyToOne(() => Dispatch)
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;

    @ManyToOne(() => IncidentReason)
    @JoinColumn({ name: 'incident_reason_id' })
    incidentReason: IncidentReason;
}
