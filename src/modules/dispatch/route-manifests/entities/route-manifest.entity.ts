import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreated } from '../../../../database/entities/base.entity.js';
import { User } from '../../../auth/users/entities/user.entity.js';
import { Vehicle } from '../../../fleet/vehicles/entities/vehicle.entity.js';
import { RouteBatch } from '../../route-batches/entities/route-batch.entity.js';

export type RouteManifestKind = 'confirmed' | 'started' | 'revised';

/**
 * ST-302.2 (ES-302): a frozen picture of a route. `confirmed` at the second approval, `started` when the route leaves
 * (at most one per batch: the baseline to measure completion) and `revised` after a later change. A change adds a new
 * `manifestVersion`; nothing is rewritten. Append-only history; the database rejects UPDATE and restricts DELETE.
 */
@Entity('route_manifests')
export class RouteManifest extends BaseCreated {
    @PrimaryGeneratedColumn({ name: 'route_manifest_id' })
    id: number;

    @Column({ name: 'route_batch_id', type: 'int' })
    routeBatchId: number;

    @Column({ name: 'manifest_version', type: 'int' })
    manifestVersion: number;

    @Column({ name: 'kind', type: 'varchar', length: 20 })
    kind: RouteManifestKind;

    /** `route_batches.version` of the batch when the manifest was frozen. */
    @Column({ name: 'route_version', type: 'int' })
    routeVersion: number;

    @Column({ name: 'vehicle_id', type: 'int', nullable: true })
    vehicleId: number | null;

    @Column({ name: 'driver_id', type: 'int', nullable: true })
    driverId: number | null;

    @Column({ name: 'actor_user_id', type: 'int', nullable: true })
    actorUserId: number | null;

    /** Mandatory for `revised`. */
    @Column({ name: 'reason', type: 'text', nullable: true })
    reason: string | null;

    @ManyToOne(() => RouteBatch, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'route_batch_id' })
    routeBatch: RouteBatch;

    @ManyToOne(() => Vehicle, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'vehicle_id' })
    vehicle: Vehicle | null;

    @ManyToOne(() => User, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'driver_id' })
    driver: User | null;

    @ManyToOne(() => User, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'actor_user_id' })
    actorUser: User | null;
}
