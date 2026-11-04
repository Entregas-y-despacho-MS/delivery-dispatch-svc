import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchStatusEnum, RouteBatchStatusEnum } from '../../../../shared/enums/index.js';
import { DispatchNotFoundException } from '../../dispatches/exceptions/dispatch-not-found.exception.js';
import { ResolveCotejoDto } from '../dto/resolve-cotejo.dto.js';
import { ResolveCotejoResponseDto } from '../dto/resolve-cotejo-response.dto.js';
import { CotejoResolutionConflictException } from '../exceptions/cotejo-resolution-conflict.exception.js';

/** Event that takes a stop out of «Excluidos por cotejo»; `RouteBatchStartService` reads it (ST-51.5). */
export const COTEJO_RESOLVED_EVENT_TYPE = 'cotejo_resolved';

/**
 * The coordinator marks a failed package check as resolved (ST-241.3, ES-241 escenario 2): the package showed up.
 * It only appends the `cotejo_resolved` event: the stop stays `assigned` and the coordinator decides afterwards.
 * One resolution frees the whole stop, even if several of its packages failed, because the start of the route
 * decides per dispatch from the latest cotejo event.
 */
@Injectable()
export class RouteBatchCotejoResolutionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async resolve(
    dispatchId: number,
    dto: ResolveCotejoDto,
    coordinatorId: number,
  ): Promise<ResolveCotejoResponseDto> {
    return await this.dataSource.transaction(async (manager) => {
      const [located]: { route_batch_id: number | null }[] = await manager.query(
        `SELECT route_batch_id FROM dispatches WHERE dispatch_id = $1`,
        [dispatchId],
      );
      if (!located) throw new DispatchNotFoundException();
      const routeBatchId = located.route_batch_id;
      if (routeBatchId === null) throw this.notPending();

      // Same order of locks as `start` and `accept` (batch, then dispatch), so a resolution and a concurrent
      // route start never interleave.
      const [batch]: { status: string }[] = await manager.query(
        `SELECT status FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
        [routeBatchId],
      );
      const [dispatch]: { route_batch_id: number | null; status: string }[] =
        await manager.query(
          `SELECT d.route_batch_id, s.name AS status
             FROM dispatches d
             JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
            WHERE d.dispatch_id = $1 FOR UPDATE OF d`,
          [dispatchId],
        );
      if (!dispatch) throw new DispatchNotFoundException();
      // The dispatch left the batch (rescheduled, cancelled) while we waited for the locks.
      if (dispatch.route_batch_id !== routeBatchId || !batch) throw this.notPending();

      if (batch.status !== RouteBatchStatusEnum.IN_EXECUTION)
        throw new CotejoResolutionConflictException(
          'ROUTE_BATCH_NOT_IN_EXECUTION',
          `The package check can only be resolved while the route batch is in execution (current status: ${batch.status}).`,
        );
      if (dispatch.status !== DispatchStatusEnum.ASSIGNED)
        throw new CotejoResolutionConflictException(
          'COTEJO_DISPATCH_NOT_ASSIGNED',
          `Only an assigned dispatch can be resolved (current status: ${dispatch.status}).`,
        );

      const [latest]: { event_type: string }[] = await manager.query(
        `SELECT e.event_type
           FROM dispatch_events e
          WHERE e.dispatch_id = $1
            AND e.event_type IN ('cotejo_failed', 'cotejo_resolved')
            AND e.metadata->>'routeBatchId' = $2::text
          ORDER BY e.created_at DESC, e.dispatch_event_id DESC
          LIMIT 1`,
        [dispatchId, routeBatchId],
      );
      if (latest?.event_type !== 'cotejo_failed') throw this.notPending();

      const note = dto.note?.trim() || null;
      const [saved]: { created_at: Date }[] = await manager.query(
        `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
         VALUES ($1, $2, $3, 'user', $4, $5::jsonb) RETURNING created_at`,
        [
          dispatchId,
          COTEJO_RESOLVED_EVENT_TYPE,
          coordinatorId,
          note ?? 'Package check failure resolved by the coordinator',
          JSON.stringify({ routeBatchId, resolvedBy: coordinatorId, note }),
        ],
      );
      return { dispatchId, routeBatchId, resolvedAt: saved.created_at.toISOString() };
    });
  }

  private notPending(): CotejoResolutionConflictException {
    return new CotejoResolutionConflictException(
      'COTEJO_EXCLUSION_NOT_PENDING',
      'The dispatch has no unresolved package-check failure in its route batch.',
    );
  }
}
