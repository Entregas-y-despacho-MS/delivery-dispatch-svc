import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsInt, IsNotEmpty, IsPositive, IsString, Max, Min } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

export class ReassignRouteBatchDto {
    @ApiProperty({
        type: [Number],
        minItems: 1,
        example: [101, 102],
        description: 'IDs of the dispatches to move, currently out_for_delivery in this (the origin) route batch.',
    })
    @IsArray()
    @ArrayNotEmpty()
    @ArrayUnique()
    @IsInt({ each: true })
    @IsPositive({ each: true })
    @Max(INT4_MAX, { each: true })
    dispatchIds!: number[];

    @ApiProperty({ example: 55, description: 'ID of the destination route batch (in_execution, with capacity for the moved dispatches).' })
    @IsInt()
    @IsPositive()
    @Max(INT4_MAX)
    targetBatchId!: number;

    @ApiProperty({ example: 'DRIVER-BREAKDOWN', description: 'Code of an active reschedule_reasons catalog entry (same catalog as POST /dispatches/:id/reschedule).' })
    @IsString()
    @IsNotEmpty()
    reasonCode!: string;

    @ApiProperty({ example: 4, description: 'Current version of this (the origin) route batch, shown to the supervisor/coordinator.' })
    @IsInt()
    @Min(0)
    version!: number;

    @ApiProperty({ example: 9, description: 'Current version of the destination route batch, shown to the supervisor/coordinator.' })
    @IsInt()
    @Min(0)
    targetVersion!: number;
}
