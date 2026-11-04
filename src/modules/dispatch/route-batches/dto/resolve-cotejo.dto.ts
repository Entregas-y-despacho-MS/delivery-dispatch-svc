import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ResolveCotejoDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 500,
    nullable: true,
    example: 'The package was found in the warehouse and handed to the driver.',
    description:
      'Optional note of the coordinator about how the failure was resolved; kept in the `cotejo_resolved` event. `null` or omitted records none.',
  })
  @IsOptional()
  @IsString({ message: 'note must be a string.' })
  @MaxLength(500, { message: 'note must not be longer than 500 characters.' })
  note?: string | null;
}
