import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, MaxLength, Max, Min } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, AUDIT_ORDERS, AUDIT_QUERY_MAX_RANGE_DAYS, AUDIT_RESULTS, ISO_WITH_OFFSET, type AuditOrder } from '../domain/admin-audit-query.js';

const dateMessage = (name: string) => `The '${name}' parameter must be an ISO 8601 date-time with an explicit offset (e.g. 2026-11-20T00:00:00-04:00).`;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class FindAdminAuditEventsParamsDto extends PaginationParamsDto {
    @ApiProperty({ type: String, format: 'date-time', description: `Start of the window, inclusive, e.g. 2026-11-20T00:00:00-04:00. ISO 8601 with an explicit offset (a '+' in the query string must be sent as %2B). The window must not exceed ${AUDIT_QUERY_MAX_RANGE_DAYS} days.` })
    @IsISO8601({ strict: true }, { message: dateMessage('from') })
    @Matches(ISO_WITH_OFFSET, { message: dateMessage('from') })
    from!: string;

    @ApiProperty({ type: String, format: 'date-time', description: "End of the window, exclusive, e.g. 2026-11-24T00:00:00-04:00. ISO 8601 with an explicit offset; must be after 'from'." })
    @IsISO8601({ strict: true }, { message: dateMessage('to') })
    @Matches(ISO_WITH_OFFSET, { message: dateMessage('to') })
    to!: string;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: INT4_MAX, description: 'Id of the user who acted.' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'actorId' parameter must be an integer." })
    @Min(1, { message: "The 'actorId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: "The 'actorId' parameter is too large." })
    actorId?: number;

    @ApiPropertyOptional({ enum: Object.values(RoleEnum), description: 'Role the actor had when the event happened.' })
    @IsOptional()
    @Transform(trim)
    @IsIn(Object.values(RoleEnum), { message: `The 'actorRole' parameter must be one of: ${Object.values(RoleEnum).join(', ')}.` })
    actorRole?: RoleEnum;

    @ApiPropertyOptional({ enum: AUDIT_ACTIONS, description: 'Audited action (catalog of RF-A35).' })
    @IsOptional()
    @Transform(trim)
    @IsIn(AUDIT_ACTIONS, { message: `The 'action' parameter must be one of: ${AUDIT_ACTIONS.join(', ')}.` })
    action?: string;

    @ApiPropertyOptional({ enum: AUDIT_ENTITY_TYPES, description: 'Type of the affected entity.' })
    @IsOptional()
    @Transform(trim)
    @IsIn(AUDIT_ENTITY_TYPES, { message: `The 'entityType' parameter must be one of: ${AUDIT_ENTITY_TYPES.join(', ')}.` })
    entityType?: string;

    @ApiPropertyOptional({ type: String, maxLength: 64, description: "Id of the affected entity. Requires 'entityType'." })
    @IsOptional()
    @Transform(trim)
    @IsString({ message: "The 'entityId' parameter must be text." })
    @MaxLength(64, { message: "The 'entityId' parameter must be at most 64 characters." })
    @Matches(/^\S+$/, { message: "The 'entityId' parameter must not be empty or contain spaces." })
    entityId?: string;

    @ApiPropertyOptional({ enum: AUDIT_RESULTS, description: 'Outcome of the request.' })
    @IsOptional()
    @Transform(trim)
    @IsIn(AUDIT_RESULTS, { message: `The 'result' parameter must be one of: ${AUDIT_RESULTS.join(', ')}.` })
    result?: (typeof AUDIT_RESULTS)[number];

    @ApiPropertyOptional({ type: String, minLength: 8, maxLength: 64, description: 'Correlation id (X-Request-Id) of the request.' })
    @IsOptional()
    @Transform(trim)
    @Matches(/^[A-Za-z0-9._:-]{8,64}$/, { message: "The 'correlationId' parameter must be 8 to 64 characters of A-Z a-z 0-9 . _ : -." })
    correlationId?: string;

    @ApiPropertyOptional({ enum: AUDIT_ORDERS, default: 'desc', description: 'Order by time of the event; ties are broken by event id in the same direction, so pages never repeat or skip rows.' })
    @IsOptional()
    @Transform(trim)
    @IsIn(AUDIT_ORDERS, { message: `The 'order' parameter must be one of: ${AUDIT_ORDERS.join(', ')}.` })
    order: AuditOrder = 'desc';
}
