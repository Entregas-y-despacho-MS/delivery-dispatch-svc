import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import type { AuditEventView } from '../domain/admin-audit-query.js';

export class AdminAuditEventDto implements AuditEventView {
    @ApiProperty({ format: 'uuid', description: 'Unique id of the audit event.' })
    eventId!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'Moment the action ended (UTC).' })
    occurredAt!: Date;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Null when the request had no authenticated actor.' })
    actorId!: number | null;

    @ApiProperty({ type: String, nullable: true, description: 'Role the actor had at that moment; null without actor.' })
    actorRole!: string | null;

    @ApiProperty({ example: 'user.role_changed', description: 'Audited action from the RF-A35 catalog.' })
    action!: string;

    @ApiProperty({ type: String, nullable: true, example: 'user', description: 'Type of the affected entity.' })
    entityType!: string | null;

    @ApiProperty({ type: String, nullable: true, description: 'Id of the affected entity; null when the action has none or it could not be known.' })
    entityId!: string | null;

    @ApiProperty({ enum: ['success', 'denied', 'failed'], description: 'success; denied for any 401/403; failed for any other error.' })
    result!: string;

    @ApiProperty({ type: 'integer', nullable: true, description: 'HTTP status the client received.' })
    statusCode!: number | null;

    @ApiProperty({ description: 'X-Request-Id of the request.' })
    correlationId!: string;

    @ApiPropertyOptional({ type: String, nullable: true, description: 'Client address. Only returned to ROOT.' })
    ip?: string | null;

    @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Declared body fields of the action. Only returned to ROOT.' })
    metadata?: Record<string, string | number | boolean | null>;
}

export class FindAdminAuditEventsResponseDto extends PaginationResponseDto<AdminAuditEventDto> {
    @ApiProperty({ type: () => [AdminAuditEventDto], description: 'Events of the page, in the requested order. Empty (not an error) when nothing matches.' })
    declare data: AdminAuditEventDto[];
}
