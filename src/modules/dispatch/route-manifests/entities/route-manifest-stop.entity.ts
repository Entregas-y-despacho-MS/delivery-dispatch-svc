import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreated } from '../../../../database/entities/base.entity.js';
import { DispatchType } from '../../dispatch-types/entities/dispatch-type.entity.js';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';
import { RouteManifest } from './route-manifest.entity.js';

/** `planned` in a `confirmed` manifest; `departing` or `excluded` in `started` and `revised`. */
export type RouteManifestStopState = 'planned' | 'departing' | 'excluded';

/**
 * ST-302.2 (ES-302): one stop of a route manifest. The current outcome of the stop is not stored: it is read from the
 * dispatch, so the baseline of the manifest does not change while the route moves. Append-only history; the database
 * rejects UPDATE and restricts DELETE.
 */
@Entity('route_manifest_stops')
export class RouteManifestStop extends BaseCreated {
    @PrimaryGeneratedColumn({ name: 'route_manifest_stop_id' })
    id: number;

    @Column({ name: 'route_manifest_id', type: 'int' })
    routeManifestId: number;

    @Column({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    @Column({ name: 'dispatch_type_id', type: 'int' })
    dispatchTypeId: number;

    @Column({ name: 'sequence_order', type: 'int', nullable: true })
    sequenceOrder: number | null;

    @Column({ name: 'stop_state', type: 'varchar', length: 20 })
    stopState: RouteManifestStopState;

    /** Why the stop does not leave (`excluded` only). */
    @Column({ name: 'exclusion_code', type: 'varchar', length: 40, nullable: true })
    exclusionCode: string | null;

    @ManyToOne(() => RouteManifest, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'route_manifest_id' })
    routeManifest: RouteManifest;

    @ManyToOne(() => Dispatch, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;

    @ManyToOne(() => DispatchType, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'dispatch_type_id' })
    dispatchType: DispatchType;
}
