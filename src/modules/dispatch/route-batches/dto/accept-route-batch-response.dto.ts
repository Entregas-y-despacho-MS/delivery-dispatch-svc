import { ApiProperty } from '@nestjs/swagger';

export class AcceptRouteBatchResponseDto {
  @ApiProperty({
    type: 'integer',
    example: 42,
    description: 'ID of the route batch the driver accepted.',
  })
  routeBatchId!: number;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-20T07:50:00.000Z',
    description:
      'UTC time when the acceptance was recorded (`accepted_at`). With it, "Start the day route" is enabled.',
  })
  acceptedAt!: string;

  @ApiProperty({
    type: 'array',
    items: { type: 'integer' },
    example: [103],
    description:
      'Dispatch IDs marked as "does not leave" because of a package-check failure. The coordinator resolves them by hand; the rest of the route can start.',
  })
  failedDispatchIds!: number[];
}
