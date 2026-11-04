import { ApiProperty } from '@nestjs/swagger';

export class CotejoExclusionFailureDto {
  @ApiProperty({
    type: String,
    example: 'PKG-0001',
    description:
      'Package id in the warehouse system (`external_package_id`) of the package that failed the check.',
  })
  packageId!: string;

  @ApiProperty({
    type: String,
    enum: ['missing', 'damaged', 'does_not_fit'],
    example: 'damaged',
    description: 'Reason the driver gave for the failure of this package.',
  })
  reason!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'The box arrived crushed on one side.',
    description: 'Free-text detail the driver added; `null` when none was given.',
  })
  detail!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://files.example.com/cotejo/photo.jpg?sig=abc',
    description:
      'Short-lived signed URL of the photo that backs the failure (valid a few minutes, ask for the list again to get a fresh one). `null` if the event has no photo or the storage could not sign it. The stored URL is never returned.',
  })
  photoUrl!: string | null;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-20T07:50:00.000Z',
    description: 'UTC time when the failure was recorded.',
  })
  reportedAt!: string;
}

export class CotejoExclusionDto {
  @ApiProperty({
    type: 'integer',
    example: 103,
    description:
      'Id of the dispatch (the stop) left out of the route. It is the id that `POST /dispatches/:id/cotejo-resolved`, `reschedule` and `cancel` take.',
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
    example: '2026-10-20',
    description: 'Shift date of the route batch (`YYYY-MM-DD`).',
  })
  shiftDate!: string;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 3,
    description: 'Position of the stop in the route; `null` when it has none.',
  })
  sequenceOrder!: number | null;

  @ApiProperty({
    type: String,
    example: 'SO-1042',
    description: 'Order reference in the origin system.',
  })
  sourceOrderRef!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'DSP-AB12CD34',
    description: 'Tracking code of the dispatch; `null` when it has none.',
  })
  trackingCode!: string | null;

  @ApiProperty({
    type: String,
    example: 'Av. Arce 2345, La Paz',
    description: 'Delivery address of the stop.',
  })
  deliveryAddress!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Maria Lopez',
    description: 'Contact name at the destination; `null` when it has none.',
  })
  contactName!: string | null;

  @ApiProperty({
    type: [CotejoExclusionFailureDto],
    description:
      'Packages that failed the check and are still unresolved, oldest first. A stop can list several, each with its own reason and photo.',
  })
  failures!: CotejoExclusionFailureDto[];
}

export class CotejoExclusionsResponseDto {
  @ApiProperty({
    type: [CotejoExclusionDto],
    description:
      'Stops left out of the route by a failed package check, ordered by shift date, batch and route order.',
  })
  data!: CotejoExclusionDto[];
}
