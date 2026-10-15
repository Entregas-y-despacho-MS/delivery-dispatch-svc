import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsInt, IsOptional, IsPositive, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ExpectedDispatchVersionDto {
    @ApiProperty({ example: 42, description: 'ID of a dispatch currently included in the route batch.' })
    @IsInt()
    @IsPositive()
    dispatchId!: number;

    @ApiProperty({ example: 3, description: 'Current dispatch version used to detect changes before approval.' })
    @IsInt()
    @Min(0)
    version!: number;
}

export class ApproveRouteBatchPromisesDto {
    @ApiProperty({ example: 7, description: 'Current route-batch version shown to the coordinator.' })
    @IsInt()
    @Min(0)
    version!: number;

    @ApiProperty({
        type: [ExpectedDispatchVersionDto],
        minItems: 1,
        description: 'Expected version of every dispatch in the batch; approval fails if the set or a version changed.',
    })
    @IsArray()
    @ArrayNotEmpty()
    @ValidateNested({ each: true })
    @Type(() => ExpectedDispatchVersionDto)
    dispatches!: ExpectedDispatchVersionDto[];

    @ApiPropertyOptional({ type: [Number], description: 'Dispatch IDs the coordinator removes before approving.' })
    @IsOptional()
    @IsArray()
    @IsInt({ each: true })
    @IsPositive({ each: true })
    removeDispatchIds?: number[];
}
