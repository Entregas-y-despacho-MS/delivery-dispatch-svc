import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { RouteBatch } from '../entities/route-batch.entity.js';
import { FindRouteBatchesParamsDto } from '../dto/find-route-batches-params.dto.js';
import { FindRouteBatchesResponseDto } from '../dto/find-route-batches-response.dto.js';
import type { RouteBatchSummaryDto } from '../dto/route-batch-summary.dto.js';
import { summarizeOccupancy, type RouteBatchOccupancy } from '../domain/route-batch-view.js';
import { RouteCapacityService } from './route-capacity.service.js';
import { toSummary } from './route-batch-summary.mapper.js';

/** Read side of the route batches for the review screens (ST-215.5). Never writes and never bumps `version`. */
@Injectable()
export class RouteBatchQueryService {
  constructor(
    @InjectRepository(RouteBatch) private readonly batches: Repository<RouteBatch>,
    private readonly capacity: RouteCapacityService,
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
