import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsPositive, Max, IsString, MaxLength, Validate } from 'class-validator';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';
import { IsPolygonBoundaryConstraint, PolygonBoundary } from '../validators/polygon-boundary.validator.js';

// Same 30-day ceiling as a service level target time: only there to reject absurd values.
const MAX_ZONE_TIME_MIN = 43200;

export class UpdateDeliveryZoneDto {
    @ApiPropertyOptional({ example: 'ZON-SUR', maxLength: 20, description: 'New code. Must not belong to another zone. null is rejected' })
    @OptionalNotNull()
    @IsString()
    @MaxLength(20, { message: 'Code must not exceed 20 characters.' })
    code?: string;

    @ApiPropertyOptional({ example: 'Zona Sur', maxLength: 100, description: 'New display name. null is rejected' })
    @OptionalNotNull()
    @IsString()
    @MaxLength(100, { message: 'Name must not exceed 100 characters.' })
    name?: string;

    @ApiPropertyOptional({ type: 'integer', example: 45, minimum: 1, maximum: 43200, description: 'New base estimated delivery time, in minutes (a whole number from 1 to 43200). null is rejected' })
    @OptionalNotNull()
    @IsInt({ message: 'Estimated time must be an integer.' })
    @IsPositive({ message: 'Estimated time must be a positive number.' })
    @Max(MAX_ZONE_TIME_MIN, { message: `Estimated time must not exceed ${MAX_ZONE_TIME_MIN} minutes.` })
    estimatedTimeMin?: number;

    @ApiPropertyOptional({
        type: 'array',
        nullable: true,
        items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        example: [[-68.15, -16.5], [-68.1, -16.5], [-68.1, -16.45], [-68.15, -16.45]],
        description: 'New coverage polygon as [longitude, latitude] coordinate pairs. Omit to keep the current polygon; send null to remove it.',
    })
    @Validate(IsPolygonBoundaryConstraint)
    boundary?: PolygonBoundary | null;
}
