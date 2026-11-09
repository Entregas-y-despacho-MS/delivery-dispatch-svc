import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { isUniqueViolation } from '../../../../shared/orm/unique-violation.js';
import { DispatchStatusEnum, RouteBatchStatusEnum } from '../../../../shared/enums/index.js';
import { RouteBatchApprovalConflictException } from '../exceptions/route-batch-approval-conflict.exception.js';
import { RouteBatchNotFoundException } from '../exceptions/route-batch-not-found.exception.js';
import { RouteCapacityService } from './route-capacity.service.js';
import { RouteBatchResourcesService } from './route-batch-resources.service.js';
import { ApproveFinalRouteBatchDto } from '../dto/approve-final-route-batch.dto.js';
import { ApproveFinalRouteBatchResponseDto } from '../dto/approve-final-route-batch-response.dto.js';
import { ROUTE_ASSIGNED_EVENT, type RouteAssignedEvent } from '../events/route-assigned.event.js';

interface BatchRow {
  id: number;
  version: number;
  status: string;
  shift_date: string;
  proposed_driver_id: number | null;
  vehicle_id: number | null;
  zone_name: string;
}

interface DispatchRow {
  id: number;
  version: number;
  status: string;
  type: string;
  priority: string;
  source_order_ref: string;
  delivery_address: string;
  delivery_latitude: string | null;
  delivery_longitude: string | null;
  scheduled_window_start: Date | null;
  scheduled_window_end: Date | null;
}

interface FinalApprovalResult extends ApproveFinalRouteBatchResponseDto {
  event: RouteAssignedEvent;
}

const APPROVAL_REASON = 'Coordinator approved the final route batch';

@Injectable()
export class RouteBatchFinalApprovalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly capacity: RouteCapacityService,
    private readonly events: EventEmitter2,
    private readonly resources: RouteBatchResourcesService,
  ) {}

  async approve(routeBatchId: number, dto: ApproveFinalRouteBatchDto, actorUserId: number): Promise<ApproveFinalRouteBatchResponseDto> {
    const runner = this.dataSource.createQueryRunner();
    let result: FinalApprovalResult;
    await runner.connect();
    try {
      await runner.startTransaction();
      try {
        result = await this.commitApproval(runner, routeBatchId, dto, actorUserId);
        await runner.commitTransaction();
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw this.mapUniqueConflict(error);
      }
    } finally {
      await runner.release();
    }

    this.events.emit(ROUTE_ASSIGNED_EVENT, result.event);
    const { event: _event, ...response } = result;
    return response;
  }

  private async commitApproval(runner: QueryRunner, routeBatchId: number, dto: ApproveFinalRouteBatchDto, actorUserId: number): Promise<FinalApprovalResult> {
    const manager = runner.manager;
    const [batch]: BatchRow[] = await manager.query(
      `SELECT b.route_batch_id AS id, b.version, b.status, b.shift_date::text AS shift_date,
              b.proposed_driver_id, b.vehicle_id, COALESCE(z.name, 'Zona sin especificar') AS zone_name
         FROM route_batches b
         LEFT JOIN delivery_zones z ON z.delivery_zone_id = b.delivery_zone_id
        WHERE b.route_batch_id = $1 FOR UPDATE OF b`,
      [routeBatchId],
    );
    if (!batch) throw new RouteBatchNotFoundException();
    if (batch.version !== dto.version) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VERSION_CONFLICT', `Route batch ${routeBatchId} changed; expected version ${dto.version}, current version ${batch.version}.`);
    }
    if (batch.status !== RouteBatchStatusEnum.PENDING_FINAL_REVIEW) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_NOT_PENDING_FINAL_REVIEW', `Route batch ${routeBatchId} must be pending final review (current status: ${batch.status}).`);
    }

    const dispatches: DispatchRow[] = await manager.query(
      `SELECT d.dispatch_id AS id, d.version, s.name AS status, t.name AS type, d.priority,
              d.source_order_ref, d.delivery_address, d.delivery_latitude, d.delivery_longitude,
              d.scheduled_window_start, d.scheduled_window_end
         FROM dispatches d
         JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
         JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
        WHERE d.route_batch_id = $1
        ORDER BY d.dispatch_id
        FOR UPDATE OF d`,
      [routeBatchId],
    );
    this.assertExpectedVersions(dispatches, dto, routeBatchId);
    if (dispatches.length === 0) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_HAS_NO_APPROVALS', `Route batch ${routeBatchId} has no dispatches to assign.`);
    }

    // A delivery must be `scheduled` (the first approval's promise); a customer pickup, still
    // `pickup_scheduled` — the generator never moves it out of that status, and it has no promise step.
    const notReady = dispatches.filter((dispatch) =>
      !(
        (dispatch.type === 'delivery' && dispatch.status === DispatchStatusEnum.SCHEDULED) ||
        (dispatch.type === 'warehouse_return_pickup' && dispatch.status === DispatchStatusEnum.PICKUP_SCHEDULED)
      ) ||
      !dispatch.delivery_address?.trim() ||
      dispatch.delivery_latitude === null || dispatch.delivery_longitude === null ||
      !dispatch.scheduled_window_start || !dispatch.scheduled_window_end ||
      dispatch.scheduled_window_start >= dispatch.scheduled_window_end,
    );
    if (notReady.length > 0) {
      throw new RouteBatchApprovalConflictException(
        'DISPATCH_NOT_READY_FOR_FINAL_APPROVAL',
        `Dispatches ${notReady.map(({ id }) => id).join(', ')} must be a scheduled delivery order or a pickup_scheduled customer pickup, with a complete destination and an unchanged, valid promise window.`,
      );
    }

    const packageRows: { dispatch_id: number; package_count: string }[] = await manager.query(
      `SELECT d.dispatch_id, COUNT(p.dispatch_package_id)::text AS package_count
         FROM dispatches d
         LEFT JOIN dispatch_packages p ON p.dispatch_id = d.dispatch_id
        WHERE d.route_batch_id = $1
        GROUP BY d.dispatch_id
        ORDER BY d.dispatch_id`,
      [routeBatchId],
    );
    // A pickup has no registered packages yet (only an estimate, no itemized boxes); the
    // capacity check already falls back to its estimated weight (calculateRouteCapacity), so this
    // completeness rule stays delivery-only.
    const deliveryIds = new Set(dispatches.filter(({ type }) => type === 'delivery').map(({ id }) => id));
    const missingPackages = packageRows
      .filter(({ dispatch_id, package_count }) => deliveryIds.has(dispatch_id) && Number(package_count) === 0)
      .map(({ dispatch_id }) => dispatch_id);
    if (missingPackages.length > 0) {
      throw new RouteBatchApprovalConflictException('DISPATCH_PACKAGES_REQUIRED', `Dispatches ${missingPackages.join(', ')} have no registered packages.`);
    }

    await this.assertOrdersBelongToOneActiveBatch(manager, batch.id, dispatches);
    const vehicleId = batch.vehicle_id;
    const driverId = batch.proposed_driver_id;
    if (vehicleId === null) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VEHICLE_REQUIRED', 'Assign a vehicle before final approval.');
    }
    if (driverId === null) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_DRIVER_REQUIRED', 'Assign a proposed driver before final approval.');
    }

    await this.resources.assertVehicleActive(manager, vehicleId);
    await this.resources.assertDriverAvailable(manager, driverId, batch.shift_date, batch.id);
    await this.resources.assertResourcesAvailable(manager, driverId, vehicleId, batch.shift_date, batch.id);
    await this.capacity.assertAssignable(batch.id, vehicleId, manager);

    const updatedBatch: { route_batch_id: number }[] = await manager.query(
      `UPDATE route_batches
          SET status = $3, driver_id = $4, vehicle_id = $5, version = version + 1, updated_at = NOW()
        WHERE route_batch_id = $1 AND version = $2 AND status = $6
        RETURNING route_batch_id`,
      [batch.id, dto.version, RouteBatchStatusEnum.CONFIRMED, driverId, vehicleId, RouteBatchStatusEnum.PENDING_FINAL_REVIEW],
    );
    if (updatedBatch.length === 0) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VERSION_CONFLICT', `Route batch ${batch.id} changed during final approval.`);
    }
    const approvedVersion = batch.version + 1;
    const dispatchIds = dispatches.map(({ id }) => id);
    for (const dispatch of dispatches) {
      const fromStatus = dispatch.type === 'warehouse_return_pickup' ? DispatchStatusEnum.PICKUP_SCHEDULED : DispatchStatusEnum.SCHEDULED;
      const updated: { dispatch_id: number }[] = await manager.query(
        `UPDATE dispatches
            SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $4),
                version = version + 1, updated_at = NOW()
          WHERE dispatch_id = $1 AND route_batch_id = $2 AND version = $3
            AND dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $5)
          RETURNING dispatch_id`,
        [dispatch.id, batch.id, dispatch.version, DispatchStatusEnum.ASSIGNED, fromStatus],
      );
      if (updated.length === 0) {
        throw new RouteBatchApprovalConflictException('DISPATCH_VERSION_CONFLICT', `Dispatch ${dispatch.id} changed during final approval.`);
      }
      await manager.query(
        `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
         VALUES ($1, 'assigned', $2, 'user', $3, $4::jsonb)`,
        [dispatch.id, actorUserId, APPROVAL_REASON, JSON.stringify({ routeBatchId: batch.id, driverId, vehicleId, previousVersion: dispatch.version, version: dispatch.version + 1 })],
      );
    }
    await manager.query(
      `INSERT INTO route_batch_events (route_batch_id, event_type, actor_user_id, actor_type, reason, metadata)
       VALUES ($1, 'final_approved', $2, 'user', $3, $4::jsonb)`,
      [batch.id, actorUserId, APPROVAL_REASON, JSON.stringify({ previousStatus: batch.status, status: RouteBatchStatusEnum.CONFIRMED, previousVersion: batch.version, version: approvedVersion, driverId, vehicleId, dispatchIds })],
    );

    const event: RouteAssignedEvent = {
      routeId: batch.id,
      driverId,
      vehicleId,
      dispatchIds,
      dispatches: dispatches.map(({ id, priority }) => ({ dispatchId: id, priority })),
      zoneName: batch.zone_name,
      version: approvedVersion,
    };
    return { routeBatchId: batch.id, version: approvedVersion, driverId, vehicleId, dispatchIds, event };
  }

  private assertExpectedVersions(dispatches: DispatchRow[], dto: ApproveFinalRouteBatchDto, routeBatchId: number): void {
    const expected = new Map<number, number>();
    for (const item of dto.dispatches) {
      if (expected.has(item.dispatchId)) {
        throw new RouteBatchApprovalConflictException('DISPATCH_VERSION_CONFLICT', `Dispatch ${item.dispatchId} appears more than once.`);
      }
      expected.set(item.dispatchId, item.version);
    }
    if (expected.size !== dispatches.length || dispatches.some(({ id, version }) => expected.get(id) !== version)) {
      const stale = dispatches.filter(({ id, version }) => expected.get(id) !== version).map(({ id }) => id);
      throw new RouteBatchApprovalConflictException('DISPATCH_VERSION_CONFLICT', `Dispatches ${stale.join(', ') || 'in the batch'} changed or are missing from approval request for route batch ${routeBatchId}.`);
    }
  }

  private async assertOrdersBelongToOneActiveBatch(manager: QueryRunner['manager'], routeBatchId: number, dispatches: DispatchRow[]): Promise<void> {
    const conflicts: { dispatch_id: number; route_batch_id: number }[] = await manager.query(
      `SELECT d.dispatch_id, d.route_batch_id
         FROM dispatches d JOIN route_batches b ON b.route_batch_id = d.route_batch_id
        WHERE d.source_order_ref = ANY($1::text[]) AND d.route_batch_id <> $2
          AND b.status NOT IN ($3, $4)
        ORDER BY b.route_batch_id, d.dispatch_id
        FOR UPDATE OF d, b`,
      [dispatches.map(({ source_order_ref }) => source_order_ref), routeBatchId, RouteBatchStatusEnum.CANCELLED, RouteBatchStatusEnum.CLOSED],
    );
    if (conflicts.length > 0) {
      throw new RouteBatchApprovalConflictException('DISPATCH_ORDER_IN_MULTIPLE_BATCHES', `Order for dispatch ${conflicts[0].dispatch_id} is already in active route batch ${conflicts[0].route_batch_id}.`);
    }
  }

  private mapUniqueConflict(error: unknown): unknown {
    if (!isUniqueViolation(error)) return error;
    const constraint = (error as { driverError?: { constraint?: string } }).driverError?.constraint;
    if (constraint === 'uq_route_batches_driver_shift_date') {
      return new RouteBatchApprovalConflictException('ROUTE_BATCH_DRIVER_NOT_AVAILABLE', 'The selected driver was assigned to another route batch for this day. Reload and review the batch.');
    }
    if (constraint === 'uq_route_batches_vehicle_shift_date') {
      return new RouteBatchApprovalConflictException('ROUTE_BATCH_RESOURCE_CONFLICT', 'The selected vehicle was assigned to another route batch for this day. Reload and review the batch.');
    }
    return new RouteBatchApprovalConflictException('ROUTE_BATCH_RESOURCE_CONFLICT', 'A route resource was assigned concurrently. Reload and review the batch.');
  }
}
