import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsOptional, Matches } from 'class-validator';
import { PaginationParamsDto } from '../../../shared/dto/index.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';

export const PICKUP_ORDER_ORIGINS = ['manual', 'rma'] as const;
export type PickupOrderOrigin = (typeof PICKUP_ORDER_ORIGINS)[number];

const DATE_MESSAGE = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const blankToUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

/** `GET /pickup-orders` (ST-81.2): filters of the Recojos page, paginated. */
export class FindPickupOrdersParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ enum: DispatchStatusEnum, description: 'Only orders in this status (e.g. `pickup_scheduled`, `address_review`, `in_planning`, `cancelled`). Omitted: every status, cancelled ones included' })
    @IsOptional()
    @Transform(blankToUndefined)
    @IsEnum(DispatchStatusEnum, { message: "The 'status' parameter must be a dispatch status." })
    status?: DispatchStatusEnum;

    @ApiPropertyOptional({ type: String, format: 'date', description: 'First preferred pickup day, in YYYY-MM-DD, inclusive (Bolivia days, America/La_Paz). Orders without a preferred day are left out when `from` or `to` is given' })
    @IsOptional()
    @Transform(blankToUndefined)
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('from') })
    from?: string;

    @ApiPropertyOptional({ type: String, format: 'date', description: 'Last preferred pickup day, in YYYY-MM-DD, inclusive (the whole day counts). Must not be before `from`' })
    @IsOptional()
    @Transform(blankToUndefined)
    @IsDateString({ strict: true }, { message: DATE_MESSAGE('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE('to') })
    to?: string;

    @ApiPropertyOptional({ enum: PICKUP_ORDER_ORIGINS, description: 'Only orders of this origin: `manual` (registered by the coordinator) or `rma` (sent by Almacén). Omitted: both' })
    @IsOptional()
    @Transform((params) => blankToUndefined({ value: lower(params) }))
    @IsIn(PICKUP_ORDER_ORIGINS, { message: "The 'origin' parameter must be one of: manual, rma." })
    origin?: PickupOrderOrigin;
}
