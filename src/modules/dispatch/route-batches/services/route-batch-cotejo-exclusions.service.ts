import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StoragePort } from '../../../../plugins/storage/storage.port.js';
import {
  CotejoExclusionDto,
  CotejoExclusionFailureDto,
  CotejoExclusionsResponseDto,
} from '../dto/cotejo-exclusion.dto.js';

/** Seconds a photo URL stays valid; the list is cheap to ask for again. */
export const COTEJO_PHOTO_ACCESS_TTL_SECONDS = 300;

interface StopRow {
  dispatchId: number;
  routeBatchId: number;
  shiftDate: string;
  sequenceOrder: number | null;
  sourceOrderRef: string;
  trackingCode: string | null;
  deliveryAddress: string;
  contactName: string | null;
}

interface CotejoEventRow {
  dispatchId: number;
  eventType: 'cotejo_failed' | 'cotejo_resolved';
  reason: string | null;
  createdAt: Date;
  metadata: {
    packageId?: string;
    packageIds?: string[];
    detail?: string | null;
    photo?: string;
  } | null;
}

/**
 * Read side of «Excluidos por cotejo» (ST-241.3, ES-241). A stop is listed while it is `assigned` in an
 * `in_execution` batch and its latest cotejo event for that batch is `cotejo_failed` (the same rule
 * `RouteBatchStartService` applies). Read only: it writes nothing.
 */
@Injectable()
export class RouteBatchCotejoExclusionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StoragePort,
  ) {}

  async findAll(): Promise<CotejoExclusionsResponseDto> {
    const stops: StopRow[] = await this.dataSource.query(
      `SELECT d.dispatch_id AS "dispatchId", d.route_batch_id AS "routeBatchId",
              to_char(b.shift_date, 'YYYY-MM-DD') AS "shiftDate", d.sequence_order AS "sequenceOrder",
              d.source_order_ref AS "sourceOrderRef", d.tracking_code AS "trackingCode",
              d.delivery_address AS "deliveryAddress", d.contact_name AS "contactName"
         FROM dispatches d
         JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
         JOIN route_batches b ON b.route_batch_id = d.route_batch_id
         JOIN LATERAL (
              SELECT e.event_type
                FROM dispatch_events e
               WHERE e.dispatch_id = d.dispatch_id
                 AND e.event_type IN ('cotejo_failed', 'cotejo_resolved')
                 AND e.metadata->>'routeBatchId' = d.route_batch_id::text
               ORDER BY e.created_at DESC, e.dispatch_event_id DESC
               LIMIT 1
         ) last ON last.event_type = 'cotejo_failed'
        WHERE s.name = 'assigned' AND b.status = 'in_execution'
        ORDER BY b.shift_date, d.route_batch_id, d.sequence_order NULLS LAST, d.dispatch_id`,
    );
    if (stops.length === 0) return { data: [] };

    const events: CotejoEventRow[] = await this.dataSource.query(
      `SELECT e.dispatch_id AS "dispatchId", e.event_type AS "eventType", e.reason,
              e.created_at AS "createdAt", e.metadata
         FROM dispatch_events e
         JOIN dispatches d ON d.dispatch_id = e.dispatch_id
        WHERE e.dispatch_id = ANY($1::int[])
          AND e.event_type IN ('cotejo_failed', 'cotejo_resolved')
          AND e.metadata->>'routeBatchId' = d.route_batch_id::text
        ORDER BY e.created_at, e.dispatch_event_id`,
      [stops.map(({ dispatchId }) => dispatchId)],
    );

    // A resolution closes every failure before it; what stays are the failures recorded after the last one.
    const pending = new Map<number, CotejoEventRow[]>();
    for (const event of events) {
      if (event.eventType === 'cotejo_resolved') pending.delete(event.dispatchId);
      else pending.set(event.dispatchId, [...(pending.get(event.dispatchId) ?? []), event]);
    }

    const signed = new Map<string, Promise<string | null>>();
    const data: CotejoExclusionDto[] = [];
    for (const stop of stops) {
      const failures: CotejoExclusionFailureDto[] = [];
      for (const event of pending.get(stop.dispatchId) ?? []) {
        failures.push({
          packageId: event.metadata?.packageId ?? event.metadata?.packageIds?.[0] ?? '',
          reason: event.reason ?? '',
          detail: event.metadata?.detail ?? null,
          photoUrl: await this.sign(event.metadata?.photo, signed),
          reportedAt: new Date(event.createdAt).toISOString(),
        });
      }
      data.push({ ...stop, failures });
    }
    return { data };
  }

  /** One photo can back several packages: it is signed once per request. A storage error leaves `null`. */
  private sign(
    stored: string | undefined,
    cache: Map<string, Promise<string | null>>,
  ): Promise<string | null> {
    if (!stored) return Promise.resolve(null);
    let url = cache.get(stored);
    if (!url) {
      url = this.storage
        .getAccessUrl(stored, COTEJO_PHOTO_ACCESS_TTL_SECONDS)
        .then(({ url: signedUrl }) => signedUrl)
        .catch(() => null);
      cache.set(stored, url);
    }
    return url;
  }
}
