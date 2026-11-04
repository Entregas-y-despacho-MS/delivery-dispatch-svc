import { ApiProperty } from '@nestjs/swagger';

export class ResolveCotejoResponseDto {
  @ApiProperty({
    type: 'integer',
    example: 103,
    description: 'Id of the dispatch whose package-check failure was marked as resolved.',
  })
  dispatchId!: number;

  @ApiProperty({
    type: 'integer',
    example: 42,
    description: 'Id of the `in_execution` route batch the stop belongs to.',
  })
  routeBatchId!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-20T09:15:00.000Z',
    description: 'UTC time when the resolution was recorded (`cotejo_resolved` event).',
  })
  resolvedAt!: string;
}
