import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';
import type { PaginationResponseDto } from '../../../../shared/dto/index.js';
import type { AuditEventView } from '../domain/admin-audit-query.js';
import { FindAdminAuditEventsParamsDto } from '../dto/find-admin-audit-events-params.dto.js';
import { FindAdminAuditEventsResponseDto } from '../dto/admin-audit-event.dto.js';
import { AdminAuditQueryService } from '../services/admin-audit-query.service.js';

/**
 * Error dictionary: INVALID_AUDIT_RANGE 400, INVALID_AUDIT_FILTER 400, VALIDATION_FAILED 400,
 *   INVALID_TOKEN 401, INSUFFICIENT_PERMISSIONS 403
 */
@ApiTags('Audit Logs')
@ApiBearerAuth('access-token')
@Controller('audit/admin-events')
export class AdminAuditEventsController {
    constructor(private readonly queryService: AdminAuditQueryService) {}

    @Get()
    @AdminOnly()
    @ApiOperation({
        summary: 'Search the administrative audit trail',
        description:
            "Returns a page of audited administrative actions (RF-A37) inside the window [from, to): 'from' is included, 'to' is not, and both carry an explicit offset (a '+' in the query string must be sent as %2B). The window must not exceed 31 days. Filters combine with AND. Ordered by event time and then by event id in the same direction ('order', default desc), so pages never repeat or skip rows. A window without events answers 200 with an empty list. The client address and the declared body fields are returned only to root. Requires administrator role, or root; coordinators, supervisors and drivers receive 403.",
    })
    @ApiBadRequests({
        validation: true,
        example: ["The 'limit' parameter must be <= 100.", "The 'from' parameter must be an ISO 8601 date-time with an explicit offset (e.g. 2026-11-20T00:00:00-04:00)."],
        errors: [
            { code: 'INVALID_AUDIT_RANGE', message: "The 'from' parameter must be before 'to'." },
            { code: 'INVALID_AUDIT_FILTER', message: "The 'entityId' parameter requires 'entityType'." },
        ],
    })
    @ApiOkResponse({ type: FindAdminAuditEventsResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async find(
        @Query() params: FindAdminAuditEventsParamsDto,
        @CurrentUser('role') role: RoleEnum,
    ): Promise<PaginationResponseDto<AuditEventView>> {
        return await this.queryService.find(params, role);
    }
}
