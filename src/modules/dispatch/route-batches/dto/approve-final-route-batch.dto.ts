import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsInt, IsPositive, Min, ValidateNested } from 'class-validator';

export class ExpectedFinalDispatchVersionDto {
  @ApiProperty({ example: 42, description: 'ID of a delivery dispatch included in the final route batch.' })
  @IsInt()
  @IsPositive()
  dispatchId!: number;

  @ApiProperty({ example: 3, description: 'Current planning version of the dispatch; a change since review returns 409.' })
  @IsInt()
  @Min(0)
  version!: number;
}

export class ApproveFinalRouteBatchDto {
  @ApiProperty({ example: 7, description: 'Current version of the batch shown during final review.' })
  @IsInt()
  @Min(0)
  version!: number;

  @ApiProperty({
    type: [ExpectedFinalDispatchVersionDto],
    minItems: 1,
    description: 'Expected version of every dispatch in the batch; approval fails if an ID or version changed.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ExpectedFinalDispatchVersionDto)
  dispatches!: ExpectedFinalDispatchVersionDto[];
}
