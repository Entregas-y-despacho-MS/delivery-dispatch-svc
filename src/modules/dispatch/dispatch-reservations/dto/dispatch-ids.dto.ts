import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional, Max, Min } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

const MAX_BATCH = 200;
const EACH = { each: true } as const;

export class ReserveDispatchesDto {
    @ApiProperty({ type: [Number], example: [12, 13, 14], description: `IDs of the orders in the batch the coordinator is about to plan (1 to ${MAX_BATCH})` })
    @IsArray({ message: "The 'dispatchIds' field must be an array." })
    @ArrayMinSize(1, { message: "The 'dispatchIds' field must contain at least one ID." })
    @ArrayMaxSize(MAX_BATCH, { message: `The 'dispatchIds' field must contain at most ${MAX_BATCH} IDs.` })
    @ArrayUnique(undefined, { message: "The 'dispatchIds' field must not repeat IDs." })
    @IsInt({ ...EACH, message: 'Every dispatch ID must be an integer.' })
    @Min(1, { ...EACH, message: 'Every dispatch ID must be >= 1.' })
    @Max(INT4_MAX, { ...EACH, message: `Every dispatch ID must be <= ${INT4_MAX}.` })
    dispatchIds!: number[];
}

export class ReleaseDispatchesDto {
    @ApiPropertyOptional({ type: [Number], example: [12, 13], description: 'IDs to release. Omit to release every reservation the coordinator holds' })
    @IsOptional()
    @IsArray({ message: "The 'dispatchIds' field must be an array." })
    @ArrayMinSize(1, { message: "The 'dispatchIds' field must contain at least one ID." })
    @ArrayMaxSize(MAX_BATCH, { message: `The 'dispatchIds' field must contain at most ${MAX_BATCH} IDs.` })
    @ArrayUnique(undefined, { message: "The 'dispatchIds' field must not repeat IDs." })
    @IsInt({ ...EACH, message: 'Every dispatch ID must be an integer.' })
    @Min(1, { ...EACH, message: 'Every dispatch ID must be >= 1.' })
    @Max(INT4_MAX, { ...EACH, message: `Every dispatch ID must be <= ${INT4_MAX}.` })
    dispatchIds?: number[];
}
