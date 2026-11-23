import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreated } from '../../../../database/entities/base.entity.js';
import { DeliveryZone } from '../../../catalog/delivery-zones/entities/delivery-zone.entity.js';
import { Warehouse } from '../../../catalog/warehouses/entities/warehouse.entity.js';
import { DispatchType } from '../../dispatch-types/entities/dispatch-type.entity.js';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';
import { RouteBatch } from '../../route-batches/entities/route-batch.entity.js';
import { PlanningCutoff } from './planning-cutoff.entity.js';

export type CutoffUniverseStatus = 'eligible' | 'excluded';

/**
 * ST-302.2 (ES-302): a dispatch the cutoff read, `eligible` (it is in the denominator of the coverage) or `excluded`
 * with a code and a readable explanation. Batch, route version, zone and warehouse are the ones at the moment of the
 * cutoff, not today's. Append-only history; the database rejects UPDATE and restricts DELETE.
 */
@Entity('planning_cutoff_dispatches')
export class PlanningCutoffDispatch extends BaseCreated {
    @PrimaryGeneratedColumn({ name: 'planning_cutoff_dispatch_id' })
    id: number;

    @Column({ name: 'planning_cutoff_id', type: 'int' })
    planningCutoffId: number;

    @Column({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    @Column({ name: 'universe_status', type: 'varchar', length: 20 })
    universeStatus: CutoffUniverseStatus;

    @Column({ name: 'exclusion_code', type: 'varchar', length: 40, nullable: true })
    exclusionCode: string | null;

    @Column({ name: 'exclusion_detail', type: 'text', nullable: true })
    exclusionDetail: string | null;

    @Column({ name: 'route_batch_id', type: 'int' })
    routeBatchId: number;

    @Column({ name: 'route_version', type: 'int' })
    routeVersion: number;

    @Column({ name: 'dispatch_type_id', type: 'int' })
    dispatchTypeId: number;

    @Column({ name: 'delivery_zone_id', type: 'int', nullable: true })
    deliveryZoneId: number | null;

    @Column({ name: 'origin_warehouse_id', type: 'int', nullable: true })
    originWarehouseId: number | null;

    @Column({ name: 'scheduled_window_start', type: 'timestamptz', nullable: true })
    scheduledWindowStart: Date | null;

    @ManyToOne(() => PlanningCutoff, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'planning_cutoff_id' })
    planningCutoff: PlanningCutoff;

    @ManyToOne(() => Dispatch, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;

    @ManyToOne(() => RouteBatch, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'route_batch_id' })
    routeBatch: RouteBatch;

    @ManyToOne(() => DispatchType, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'dispatch_type_id' })
    dispatchType: DispatchType;

    @ManyToOne(() => DeliveryZone, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'delivery_zone_id' })
    deliveryZone: DeliveryZone | null;

    @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'origin_warehouse_id' })
    originWarehouse: Warehouse | null;
}
