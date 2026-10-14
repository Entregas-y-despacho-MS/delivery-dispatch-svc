import { ApiProperty } from '@nestjs/swagger';

class CapacityMeasureDto {
  @ApiProperty({
    description: 'Measured total load in kilograms or cubic meters.',
    type: 'number',
    format: 'double',
    example: 820.5,
  })
  actual!: number;

  @ApiProperty({
    description: 'Vehicle capacity in the same unit as the measured load.',
    type: 'number',
    format: 'double',
    example: 1000,
  })
  capacity!: number;

  @ApiProperty({
    description: 'Share of vehicle capacity used, as a percentage.',
    type: 'number',
    format: 'double',
    example: 82.05,
  })
  usedPercent!: number;

  @ApiProperty({
    description:
      'Unused vehicle capacity in the same unit as the measured load.',
    type: 'number',
    format: 'double',
    example: 179.5,
  })
  remaining!: number;

  @ApiProperty({
    description:
      'Load exceeding vehicle capacity in the same unit; zero when within capacity.',
    type: 'number',
    format: 'double',
    example: 0,
  })
  excess!: number;
}

class PackageDimensionExcessDto {
  @ApiProperty({
    description: 'Package dimension that exceeds the vehicle limit.',
    enum: ['lengthCm', 'widthCm', 'heightCm'],
    example: 'widthCm',
  })
  dimension!: 'lengthCm' | 'widthCm' | 'heightCm';

  @ApiProperty({
    description: 'Measured package dimension in centimeters.',
    type: 'number',
    format: 'double',
    example: 125,
  })
  actual!: number;

  @ApiProperty({
    description: 'Maximum permitted package dimension in centimeters.',
    type: 'number',
    format: 'double',
    example: 100,
  })
  maximum!: number;
}

class PackageDimensionViolationDto {
  @ApiProperty({
    description: 'Dispatch containing the oversized package.',
    type: 'integer',
    example: 31,
  })
  dispatchId!: number;

  @ApiProperty({
    description: 'Package exceeding one or more vehicle dimension limits.',
    type: 'integer',
    example: 82,
  })
  packageId!: number;

  @ApiProperty({
    description: 'Vehicle dimension limits exceeded by this package.',
    type: () => PackageDimensionExcessDto,
    isArray: true,
  })
  exceeded!: PackageDimensionExcessDto[];
}

export class RouteCapacityReportDto {
  @ApiProperty({
    description:
      'Dispatch IDs whose weight came from estimates because no package records exist.',
    type: 'integer',
    isArray: true,
    example: [31, 32],
  })
  estimatedDispatchIds!: number[];

  @ApiProperty({
    description:
      'Total package weight, capacity, utilization, remaining capacity, and excess in kilograms.',
    type: () => CapacityMeasureDto,
  })
  weight!: CapacityMeasureDto;

  @ApiProperty({
    description:
      'Total package volume, capacity, utilization, remaining capacity, and excess in cubic meters.',
    type: () => CapacityMeasureDto,
  })
  volume!: CapacityMeasureDto;

  @ApiProperty({
    description: 'Packages that exceed a configured vehicle dimension limit.',
    type: () => PackageDimensionViolationDto,
    isArray: true,
  })
  dimensionViolations!: PackageDimensionViolationDto[];

  @ApiProperty({
    description: 'Whether the route can be assigned to the selected vehicle.',
    example: true,
  })
  assignable!: boolean;
}
