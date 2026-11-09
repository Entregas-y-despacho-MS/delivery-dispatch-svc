import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../database/entities/base.entity.js';
import { OperationalAlertKindEnum, OperationalAlertSeverityEnum, OperationalAlertStatusEnum } from '../../../shared/enums/operational-alert.enum.js';
import { DeliveryZone } from '../../catalog/delivery-zones/entities/delivery-zone.entity.js';
import { Dispatch } from '../../dispatch/dispatches/entities/dispatch.entity.js';
import { User } from '../../auth/users/entities/user.entity.js';
import { Vehicle } from '../../fleet/vehicles/entities/vehicle.entity.js';

// Standalone schema group (delivery-dispatch-db migration 026) — references auth/fleet/catalog/dispatch
// but is not owned by any of them. uq_operational_alerts_open_subject (kind + zone/dispatch/driver,
// WHERE status='open') is what keeps the evaluator from ever raising a duplicate while one stays open.
@Entity('operational_alerts')
export class OperationalAlert extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'operational_alert_id' })
    id: number;

    @Column({ name: 'kind', type: 'varchar', length: 30 })
    kind: OperationalAlertKindEnum;

    @Column({ name: 'severity', type: 'varchar', length: 20 })
    severity: OperationalAlertSeverityEnum;

    @Column({ name: 'zone_id', type: 'int', nullable: true })
    zoneId: number | null;

    @Column({ name: 'dispatch_id', type: 'int', nullable: true })
    dispatchId: number | null;

    @Column({ name: 'driver_id', type: 'int', nullable: true })
    driverId: number | null;

    @Column({ name: 'vehicle_id', type: 'int', nullable: true })
    vehicleId: number | null;

    @Column({ name: 'acknowledged_by', type: 'int', nullable: true })
    acknowledgedBy: number | null;

    @Column({ name: 'detail', type: 'jsonb', default: {} })
    detail: Record<string, unknown>;

    @Column({ name: 'status', type: 'varchar', length: 20, default: OperationalAlertStatusEnum.OPEN })
    status: OperationalAlertStatusEnum;

    @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
    acknowledgedAt: Date | null;

    @ManyToOne(() => DeliveryZone)
    @JoinColumn({ name: 'zone_id' })
    zone: DeliveryZone | null;

    @ManyToOne(() => Dispatch)
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch | null;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'driver_id' })
    driver: User | null;

    @ManyToOne(() => Vehicle)
    @JoinColumn({ name: 'vehicle_id' })
    vehicle: Vehicle | null;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'acknowledged_by' })
    acknowledgedByUser: User | null;
}
