import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import type { PaginationResponseDto } from '../../../../shared/dto/index.js';
import type { RoleEnum } from '../../../../shared/enums/index.js';
import {
    assertEntityFilter, AUDIT_EXPORT_MAX_ROWS, resolveAuditRange, toAuditEventView,
    type AuditEventView, type AuditExportFormat,
} from '../domain/admin-audit-query.js';
import type { FindAdminAuditEventsParamsDto } from '../dto/find-admin-audit-events-params.dto.js';
import { AdminAuditEventEntity } from '../entities/admin-audit-event.entity.js';
import { AuditExportLimitExceededException } from '../exceptions/invalid-audit-query.exception.js';

/** What an export holds: the filtered events as the caller's role may see them, and the window they belong to. */
export interface AuditExportResult {
    range: { from: Date; to: Date };
    events: AuditEventView[];
}

/**
 * Search over the audit trail (RF-A37) and the export of that same search (RF-A38). Read only: the trail is
 * append-only and this service never writes to it. Pages are stable because the order is always `occurred_at` plus
 * the event id as tie-breaker, in the same direction. The search and the export build their query in one place
 * (`filteredQuery`), so an export holds exactly the ids, in the order, that the search lists.
 */
@Injectable()
export class AdminAuditQueryService {
    constructor(@InjectRepository(AdminAuditEventEntity) private readonly repo: Repository<AdminAuditEventEntity>) {}

    async find(params: FindAdminAuditEventsParamsDto, role: RoleEnum): Promise<PaginationResponseDto<AuditEventView>> {
        const { query } = this.filteredQuery(params);
        const page = params.page ?? 1;
        const limit = params.limit ?? 10;

        const [events, total] = await query.skip((page - 1) * limit).take(limit).getManyAndCount();

        return {
            data: events.map((event) => toAuditEventView(event, role)),
            meta: { page, limit, total, pages: total === 0 ? 0 : Math.ceil(total / limit) },
        };
    }

    /**
     * Every event of the filtered result, in the order of the search, for a file of `format`. It reads one row more than
     * the format allows: if that extra row arrives the result is too large and nothing is returned (no separate count, so
     * the check and the data come from the same read). An empty result is valid.
     */
    async findForExport(params: FindAdminAuditEventsParamsDto, format: AuditExportFormat, role: RoleEnum): Promise<AuditExportResult> {
        const { query, range } = this.filteredQuery(params);
        const maxRows = AUDIT_EXPORT_MAX_ROWS[format];

        const events = await query.take(maxRows + 1).getMany();
        if (events.length > maxRows) throw new AuditExportLimitExceededException(format, maxRows);

        return { range, events: events.map((event) => toAuditEventView(event, role)) };
    }

    /** Window, filters and order shared by the search and the export; validates before the database is touched. */
    private filteredQuery(params: FindAdminAuditEventsParamsDto): { query: SelectQueryBuilder<AdminAuditEventEntity>; range: { from: Date; to: Date } } {
        const range = resolveAuditRange(params.from, params.to);
        assertEntityFilter(params.entityType, params.entityId);
        const direction = params.order === 'asc' ? 'ASC' : 'DESC';

        const query = this.repo
            .createQueryBuilder('event')
            .where('event.occurredAt >= :from AND event.occurredAt < :to', range);
        if (params.actorId !== undefined) query.andWhere('event.actorUserId = :actorId', { actorId: params.actorId });
        if (params.actorRole !== undefined) query.andWhere('event.actorRole = :actorRole', { actorRole: params.actorRole });
        if (params.action !== undefined) query.andWhere('event.action = :action', { action: params.action });
        if (params.entityType !== undefined) query.andWhere('event.entityType = :entityType', { entityType: params.entityType });
        if (params.entityId !== undefined) query.andWhere('event.entityId = :entityId', { entityId: params.entityId });
        if (params.result !== undefined) query.andWhere('event.result = :result', { result: params.result });
        if (params.correlationId !== undefined) query.andWhere('event.correlationId = :correlationId', { correlationId: params.correlationId });

        query.orderBy('event.occurredAt', direction).addOrderBy('event.id', direction);
        return { query, range };
    }
}
