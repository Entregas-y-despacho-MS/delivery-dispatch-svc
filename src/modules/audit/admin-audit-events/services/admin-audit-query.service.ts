import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { PaginationResponseDto } from '../../../../shared/dto/index.js';
import type { RoleEnum } from '../../../../shared/enums/index.js';
import { assertEntityFilter, resolveAuditRange, toAuditEventView, type AuditEventView } from '../domain/admin-audit-query.js';
import type { FindAdminAuditEventsParamsDto } from '../dto/find-admin-audit-events-params.dto.js';
import { AdminAuditEventEntity } from '../entities/admin-audit-event.entity.js';

/**
 * Search over the audit trail (RF-A37). Read only: the trail is append-only and this service never writes to it.
 * Pages are stable because the order is always `occurred_at` plus the event id as tie-breaker, in the same direction.
 */
@Injectable()
export class AdminAuditQueryService {
    constructor(@InjectRepository(AdminAuditEventEntity) private readonly repo: Repository<AdminAuditEventEntity>) {}

    async find(params: FindAdminAuditEventsParamsDto, role: RoleEnum): Promise<PaginationResponseDto<AuditEventView>> {
        const range = resolveAuditRange(params.from, params.to);
        assertEntityFilter(params.entityType, params.entityId);
        const page = params.page ?? 1;
        const limit = params.limit ?? 10;
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

        const [events, total] = await query
            .orderBy('event.occurredAt', direction)
            .addOrderBy('event.id', direction)
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        return {
            data: events.map((event) => toAuditEventView(event, role)),
            meta: { page, limit, total, pages: total === 0 ? 0 : Math.ceil(total / limit) },
        };
    }
}
