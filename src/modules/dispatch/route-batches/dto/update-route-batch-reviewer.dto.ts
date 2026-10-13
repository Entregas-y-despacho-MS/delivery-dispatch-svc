import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, Max, MaxLength } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

export class UpdateRouteBatchReviewerDto {
    @ApiProperty({
        type:        'integer',
        example:     12,
        description: 'User that will review the whole batch from now on. Must be an active coordinator or supervisor; any other user (inactive, deleted, another role, unknown id) is a 409 ROUTE_BATCH_REVIEWER_NOT_ELIGIBLE. Sending the current reviewer is accepted and changes nothing',
    })
    @IsInt({ message: 'The reviewer user ID must be an integer.' })
    @IsPositive({ message: 'The reviewer user ID must be a positive number.' })
    @Max(INT4_MAX, { message: 'The reviewer user ID is too large.' })
    reviewerUserId!: number;

    @ApiPropertyOptional({
        type:        String,
        maxLength:   500,
        example:     'Coordinator on leave until Monday.',
        description: 'Why the batch is being handed over. Stored in the batch event log; omitted or null stores nothing',
    })
    @IsOptional()
    @IsString({ message: 'The reason must be a string.' })
    @IsNotEmpty({ message: 'The reason must not be empty.' })
    @MaxLength(500, { message: 'The reason must be at most 500 characters.' })
    reason?: string | null;
}
