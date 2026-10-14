import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ScheduledTaskRegistry } from '../../../app/scheduler/services/scheduled-task-registry.service.js';
import { MessageBus } from '../../../plugins/messaging/message-bus.port.js';
import { buildEnvelope } from '../../../plugins/messaging/envelope/message-envelope.js';
import { SettingsService } from '../../settings/services/settings.service.js';
import type { ChangeRequiresAttention } from '../sales-order-intake/ports/existing-dispatch-changes.port.js';
import { DISPATCH_CHANGE_REQUIRES_ATTENTION } from '../sales-order-intake/services/dispatch-change-events.service.js';

const TASK_NAME = 'incomplete-order-recovery';
const RETRY_INTERVAL_MINUTES = 15;
const MAX_ATTEMPTS = 3;
const DEFAULT_ALERT_MINUTES = 60;

type RecoverySource = 'marketplace' | 'inventory';
type RecoveryEntityType = 'sales_order' | 'shipment';

interface RecoveryCandidate {
  sales_order_id: string;
  source: RecoverySource;
  entity_type: RecoveryEntityType;
  observed_at: Date | string;
}

interface RecoveryState {
  source: RecoverySource;
  sync_attempts: number;
  last_sync_requested_at: Date | string | null;
  incomplete_alerted_at: Date | string | null;
  base_received: boolean;
  cancelled_at: Date | string | null;
}

interface RecoveryProgress {
  total_attempts: number;
  last_requested_at: Date | string | null;
  alerted: boolean;
}

type RecoveryAlert = Required<
  Pick<
    ChangeRequiresAttention,
    'salesOrderId' | 'source' | 'receivedAt' | 'changeType'
  >
>;

@Injectable()
export class IncompleteOrderRecoveryTask implements OnModuleInit {
  private readonly logger = new Logger(IncompleteOrderRecoveryTask.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly bus: MessageBus,
    private readonly events: EventEmitter2,
    private readonly tasks: ScheduledTaskRegistry,
  ) {}

  onModuleInit(): void {
    this.tasks.register({
      name: TASK_NAME,
      schedule: { kind: 'every-minutes', minutes: RETRY_INTERVAL_MINUTES },
      run: async ({ startedAt }) => await this.recover(startedAt),
    });
  }

  async recover(now = new Date()): Promise<void> {
    const alertMinutes = await this.settings.getNumber(
      'incomplete_order_alert_minutes',
      DEFAULT_ALERT_MINUTES,
    );
    const candidates: RecoveryCandidate[] = await this.dataSource.query(
      `WITH available AS (
         SELECT sales_order_id, created_at, 'marketplace'::text AS available_source
           FROM pending_sales_orders
         UNION ALL
         SELECT sales_order_id, created_at, 'inventory'::text AS available_source
           FROM pending_shipments
       ), missing AS (
         SELECT sales_order_id, 'inventory'::text AS source, 'shipment'::text AS entity_type, created_at AS observed_at
           FROM pending_sales_orders
         UNION ALL
         SELECT sales_order_id, 'marketplace'::text AS source, 'sales_order'::text AS entity_type, created_at AS observed_at
           FROM pending_shipments
       )
      SELECT DISTINCT ON (missing.sales_order_id, missing.source)
              missing.sales_order_id, missing.source, missing.entity_type, missing.observed_at
         FROM missing
         JOIN available ON available.sales_order_id = missing.sales_order_id
                       AND available.available_source <> missing.source
        WHERE missing.observed_at <= $1::timestamptz - make_interval(mins => $2)
          AND NOT EXISTS (
                SELECT 1 FROM sales_order_sync_states target
                 WHERE target.sales_order_id = missing.sales_order_id
                   AND target.source = missing.source
                   AND (target.base_received = TRUE OR target.cancelled_at IS NOT NULL)
              )
          AND NOT EXISTS (
                SELECT 1 FROM sales_order_sync_states cancelled
                 WHERE cancelled.sales_order_id = missing.sales_order_id
                   AND cancelled.cancelled_at IS NOT NULL
              )
        ORDER BY missing.sales_order_id, missing.source, missing.observed_at ASC`,
      [now, alertMinutes],
    );

    for (const candidate of candidates) {
      const alert = await this.processCandidate(candidate, now);
      if (alert) this.events.emit(DISPATCH_CHANGE_REQUIRES_ATTENTION, alert);
    }
  }

  private async processCandidate(
    candidate: RecoveryCandidate,
    now: Date,
  ): Promise<RecoveryAlert | null> {
    return await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO sales_order_sync_states (sales_order_id, source, last_record_version, base_received)
         VALUES ($1, $2, 0, false)
         ON CONFLICT (sales_order_id, source) DO NOTHING`,
        [candidate.sales_order_id, candidate.source],
      );

      const states: RecoveryState[] = await manager.query(
        `SELECT source, sync_attempts, last_sync_requested_at, incomplete_alerted_at, base_received, cancelled_at
           FROM sales_order_sync_states
          WHERE sales_order_id = $1
          ORDER BY source
          FOR UPDATE`,
        [candidate.sales_order_id],
      );
      const state = states.find(({ source }) => source === candidate.source);
      if (!state || state.base_received || state.cancelled_at) return null;
      if (states.some(({ cancelled_at }) => cancelled_at !== null)) return null;

      const progress = summarizeProgress(states);

      if (progress.total_attempts >= MAX_ATTEMPTS) {
        if (progress.alerted) return null;
        await this.markAlerted(manager, candidate, now);
        return this.toAlert(candidate, now);
      }

      if (
        progress.last_requested_at &&
        elapsedMinutes(progress.last_requested_at, now) < RETRY_INTERVAL_MINUTES
      ) {
        return null;
      }

      const attempt = progress.total_attempts + 1;
      const requestedAt = now.toISOString();
      await this.bus.publish(
        'dispatch.sync.requested',
        buildEnvelope({
          type: 'dispatch.sync.requested',
          source: 'dispatch',
          occurredAt: now,
          data: {
            entityType: candidate.entity_type,
            entityId: candidate.sales_order_id,
            requestedAt,
            attempt,
          },
        }),
      );

      await manager.query(
        `UPDATE sales_order_sync_states
            SET sync_attempts = $3, last_sync_requested_at = $4
          WHERE sales_order_id = $1 AND source = $2`,
        [
          candidate.sales_order_id,
          candidate.source,
          state.sync_attempts + 1,
          now,
        ],
      );
      this.logger.log(
        `Requested recovery of ${candidate.entity_type} ${candidate.sales_order_id} (attempt ${attempt}/${MAX_ATTEMPTS}).`,
      );

      if (attempt !== MAX_ATTEMPTS) return null;
      await this.markAlerted(manager, candidate, now);
      return this.toAlert(candidate, now);
    });
  }

  private async markAlerted(
    manager: EntityManager,
    candidate: RecoveryCandidate,
    now: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE sales_order_sync_states
          SET incomplete_alerted_at = $3
        WHERE sales_order_id = $1 AND source = $2 AND incomplete_alerted_at IS NULL`,
      [candidate.sales_order_id, candidate.source, now],
    );
  }

  private toAlert(candidate: RecoveryCandidate, now: Date): RecoveryAlert {
    return {
      salesOrderId: candidate.sales_order_id,
      source: candidate.source,
      changeType: 'incomplete_order',
      receivedAt: now.toISOString(),
    };
  }
}

function elapsedMinutes(from: Date | string, to: Date): number {
  return (to.getTime() - new Date(from).getTime()) / 60_000;
}

function summarizeProgress(states: RecoveryState[]): RecoveryProgress {
  return {
    total_attempts: states.reduce(
      (total, state) => total + state.sync_attempts,
      0,
    ),
    last_requested_at:
      states
        .map(({ last_sync_requested_at }) => last_sync_requested_at)
        .filter(
          (requestedAt): requestedAt is Date | string => requestedAt !== null,
        )
        .sort(
          (left, right) => new Date(right).getTime() - new Date(left).getTime(),
        )[0] ?? null,
    alerted: states.some(
      ({ incomplete_alerted_at }) => incomplete_alerted_at !== null,
    ),
  };
}
