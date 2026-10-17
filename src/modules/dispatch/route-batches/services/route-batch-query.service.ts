import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import { RouteBatch } from '../entities/route-batch.entity.js';
import { FindRouteBatchesParamsDto } from '../dto/find-route-batches-params.dto.js';
import { FindRouteBatchesResponseDto } from '../dto/find-route-batches-response.dto.js';
import type { RouteBatchSummaryDto } from '../dto/route-batch-summary.dto.js';
import { summarizeOccupancy, toValidation, type CutoffEventRow, type RouteBatchOccupancy } from '../domain/route-batch-view.js';
import type { RouteBatchDetailDto, RouteBatchDispatchDto, RouteBatchPackageDto } from '../dto/route-batch-detail.dto.js';
import { RouteBatchNotFoundException } from '../exceptions/index.js';
import { RouteCapacityService } from './route-capacity.service.js';
import { toSummary } from './route-batch-summary.mapper.js';

/** Read side of the route batches for the review screens (ST-215.5). Never writes and never bumps `version`. */
@Injectable()
export class RouteBatchQueryService {
  constructor(
    @InjectRepository(RouteBatch) private readonly batches: Repository<RouteBatch>,
    private readonly capacity: RouteCapacityService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async findAll(params: FindRouteBatchesParamsDto): Promise<FindRouteBatchesResponseDto> {
    const { page, limit, status, shiftDate, reviewerUserId, withoutReviewer } = params;
    const query = this.batches
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.deliveryZone', 'zone')
      .leftJoinAndSelect('b.vehicle', 'vehicle')
      .leftJoinAndSelect('b.proposedDriver', 'proposedDriver')
      .leftJoinAndSelect('b.reviewerUser', 'reviewer');

    if (status) query.andWhere('b.status = :status', { status });
    if (shiftDate) query.andWhere('b.shiftDate = :shiftDate', { shiftDate });
    // A reviewer alone is "mine"; withoutReviewer alone is "nobody's"; both together is the coordinator's queue (D-42).
    const wantsReviewer = reviewerUserId !== undefined;
    const wantsUnassigned = withoutReviewer === true;
    if (wantsReviewer || wantsUnassigned) {
      query.andWhere(
        new Brackets((qb) => {
          if (wantsReviewer) qb.orWhere('b.reviewerUserId = :reviewerUserId', { reviewerUserId });
          if (wantsUnassigned) qb.orWhere('b.reviewerUserId IS NULL');
        }),
      );
    }

    const [rows, total] = await query
      .orderBy('b.shiftDate', 'ASC')
      .addOrderBy('b.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const counts = await this.countDispatches(rows.map((row) => row.id));
    const data: RouteBatchSummaryDto[] = [];
    for (const row of rows) {
      data.push(toSummary(row, counts.get(row.id) ?? 0, await this.occupancyOf(row)));
    }
    return { data, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * Everything is read in one read-only REPEATABLE READ transaction, so the batch `version`, each dispatch `version`,
   * the packages and the capacity come from the same snapshot (they are the expected versions of both approvals).
   */
  async findOne(id: number): Promise<RouteBatchDetailDto> {
    return await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      const batch = await manager.getRepository(RouteBatch).findOne({
        where: { id },
        relations: { deliveryZone: true, vehicle: true, proposedDriver: true, reviewerUser: true },
      });
      if (!batch) throw new RouteBatchNotFoundException();

      const dispatches = await this.loadDispatches(manager, id);
      const report =
        batch.vehicleId !== null && batch.vehicle
          ? await this.capacity.report(id, batch.vehicleId, manager, { lock: false })
          : null;
      const validation = toValidation(await this.lastCutoffEvent(manager, id));
      return {
        ...toSummary(batch, dispatches.length, summarizeOccupancy(report)),
        dispatches,
        capacity: report,
        validation,
      };
    });
  }

  private async loadDispatches(manager: EntityManager, batchId: number): Promise<RouteBatchDispatchDto[]> {
    const rows: Array<{
      dispatchId: number;
      version: number;
      status: string;
      sequenceOrder: number | null;
      sourceOrderRef: string;
      deliveryAddress: string;
      scheduledWindowStart: Date | null;
      scheduledWindowEnd: Date | null;
    }> = await manager.query(
      `SELECT d.dispatch_id AS "dispatchId", d.version, s.name AS status, d.sequence_order AS "sequenceOrder",
              d.source_order_ref AS "sourceOrderRef", d.delivery_address AS "deliveryAddress",
              d.scheduled_window_start AS "scheduledWindowStart", d.scheduled_window_end AS "scheduledWindowEnd"
         FROM dispatches d
         JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
        WHERE d.route_batch_id = $1
        ORDER BY d.sequence_order ASC NULLS LAST, d.dispatch_id ASC`,
      [batchId],
    );
    if (rows.length === 0) return [];

    const packageRows: Array<{
      id: number;
      dispatchId: number;
      externalPackageId: string;
      lengthCm: string;
      widthCm: string;
      heightCm: string;
      grossWeightKg: string;
    }> = await manager.query(
      `SELECT dispatch_package_id AS id, dispatch_id AS "dispatchId", external_package_id AS "externalPackageId",
              length_cm AS "lengthCm", width_cm AS "widthCm", height_cm AS "heightCm", gross_weight_kg AS "grossWeightKg"
         FROM dispatch_packages
        WHERE dispatch_id = ANY($1)
        ORDER BY dispatch_package_id`,
      [rows.map((row) => row.dispatchId)],
    );
    const packagesByDispatch = new Map<number, RouteBatchPackageDto[]>();
    for (const row of packageRows) {
      const list = packagesByDispatch.get(row.dispatchId) ?? [];
      list.push({
        id: row.id,
        externalPackageId: row.externalPackageId,
        lengthCm: Number(row.lengthCm),
        widthCm: Number(row.widthCm),
        heightCm: Number(row.heightCm),
        grossWeightKg: Number(row.grossWeightKg),
      });
      packagesByDispatch.set(row.dispatchId, list);
    }
    return rows.map((row) => {
      const packages = packagesByDispatch.get(row.dispatchId) ?? [];
      return { ...row, estimated: packages.length === 0, packages };
    });
  }

  private async lastCutoffEvent(manager: EntityManager, batchId: number): Promise<CutoffEventRow | null> {
    const [row]: Array<{ eventType: string; createdAt: Date; reason: string | null; metadata: Record<string, unknown> | null }> =
      await manager.query(
        `SELECT event_type AS "eventType", created_at AS "createdAt", reason, metadata
           FROM route_batch_events
          WHERE route_batch_id = $1 AND event_type IN ('cutoff_validated', 'cutoff_failed')
          ORDER BY created_at DESC, route_batch_event_id DESC
          LIMIT 1`,
        [batchId],
      );
    return row ?? null;
  }

  /** A batch without vehicle has no occupancy; the report is only computed for the page being returned. */
  private async occupancyOf(batch: RouteBatch): Promise<RouteBatchOccupancy | null> {
    if (batch.vehicleId === null || !batch.vehicle) return null;
    return summarizeOccupancy(await this.capacity.report(batch.id, batch.vehicleId));
  }

  private async countDispatches(batchIds: number[]): Promise<Map<number, number>> {
    if (batchIds.length === 0) return new Map();
    const rows: Array<{ id: number; total: string }> = await this.batches.query(
      `SELECT route_batch_id AS id, COUNT(*) AS total FROM dispatches WHERE route_batch_id = ANY($1) GROUP BY route_batch_id`,
      [batchIds],
    );
    return new Map(rows.map((row) => [row.id, Number(row.total)]));
  }
}
