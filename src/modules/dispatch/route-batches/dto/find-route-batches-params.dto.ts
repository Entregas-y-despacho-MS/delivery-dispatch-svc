import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { RouteBatchStatusEnum } from '../../../../shared/enums/index.js';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export class FindRouteBatchesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ enum: RouteBatchStatusEnum, description: 'Only the batches in this status. Any batch status is accepted; the review screens use `provisional` (1st approval) and `pending_final_review` (2nd approval). Omit for every status' })
    @IsOptional()
    @IsEnum(RouteBatchStatusEnum, { message: "The 'status' parameter must be one of: provisional, pending_final_review, confirmed, in_execution, closed, cancelled." })
    status?: RouteBatchStatusEnum;

    @ApiPropertyOptional({ type: String, format: 'date', example: '2026-10-17', description: 'Only the batches of this shift date (YYYY-MM-DD)' })
    @IsOptional()
    @IsDateString({ strict: true }, { message: 'shiftDate must be a valid date in YYYY-MM-DD format.' })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'shiftDate must be a valid date in YYYY-MM-DD format.' })
    shiftDate?: string;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, example: 7, description: 'Only the batches reviewed by this user. Combine with `withoutReviewer=true` to also get the batches nobody reviews (the coordinator\'s own queue, D-42)' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'reviewerUserId' parameter must be an integer." })
    @Min(1, { message: "The 'reviewerUserId' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'reviewerUserId' parameter must be <= ${INT4_MAX}.` })
    reviewerUserId?: number;

    @ApiPropertyOptional({ description: 'true = include the batches without reviewer (visible to everyone). Alone it returns only those batches; with `reviewerUserId` it returns that reviewer\'s batches plus the ones without reviewer. false or omitted = it adds nothing' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'withoutReviewer'))
    @IsBoolean()
    withoutReviewer?: boolean;
}
