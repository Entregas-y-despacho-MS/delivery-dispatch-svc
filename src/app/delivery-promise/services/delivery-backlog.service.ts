import { Injectable } from '@nestjs/common';
import { assertSlaRange } from '../../sla-report/domain/sla-date-range.js';
import { buildBacklogReport } from '../domain/backlog-report.js';
import { OTD_DATE_BASIS, OtdBasis } from '../domain/otd-basis.js';
import type { DeliveryBacklogDto } from '../dto/delivery-backlog.dto.js';
import { OVERDUE_LIST_DEFAULT_LIMIT } from '../dto/delivery-promise-params.dto.js';
import { BacklogRepository } from '../repositories/backlog.repository.js';
import type { DeliveryPromiseFilters } from '../repositories/delivery-promise.sql.js';

/**
 * ST-301.1 — the volume of the backlog next to the OTD: delivered, open overdue, pending by exclusive stage and age,
 * failed, rescheduled, cancelled and returned, each dispatch counted once by its own `dispatchId` and status (never by
 * the status of its batch). Nothing is cached: the open overdue dispatches change every minute.
 */
@Injectable()
export class DeliveryBacklogService {
    constructor(private readonly repository: BacklogRepository) {}

    async getBacklog(filters: DeliveryPromiseFilters, limit: number = OVERDUE_LIST_DEFAULT_LIMIT, now: Date = new Date()): Promise<DeliveryBacklogDto> {
        assertSlaRange(filters.from, filters.to);
        // Both reads use the same cut, so the list is always a part of the `openOverdue` count.
        const [rows, overdueList] = await Promise.all([this.repository.countByStatus(filters, now), this.repository.listOpenOverdue(filters, now, limit)]);
        return buildBacklogReport(filters, rows, overdueList, OTD_DATE_BASIS[OtdBasis.PROMISE], now);
    }
}
