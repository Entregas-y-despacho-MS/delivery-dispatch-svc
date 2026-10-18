import { ApiProperty } from '@nestjs/swagger';

export class StartRouteBatchResponseDto {
  @ApiProperty({
    type: 'integer',
    example: 42,
    description: 'ID of the route batch that started.',
  })
  routeBatchId!: number;

  @ApiProperty({
    enum: ['in_execution'],
    example: 'in_execution',
    description: 'State of the route batch after it started.',
  })
  status!: 'in_execution';

  @ApiProperty({
    type: [Number],
    example: [101, 102],
    description: 'Dispatch IDs in the route, in visit order.',
  })
  dispatchIds!: number[];

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-18T12:30:00.000Z',
    description: 'UTC time when the route and custody transfer were recorded.',
  })
  startedAt!: string;
}
