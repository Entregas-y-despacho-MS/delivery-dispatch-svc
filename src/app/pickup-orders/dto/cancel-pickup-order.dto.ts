import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * `PATCH /pickup-orders/:id/cancel` (ST-81.2). Same fields as the cancellation of a delivery (`CancelDispatchDto`), but the
 * causal is trimmed, so a reason made only of spaces is refused. `CancelDispatchDto` is left as it was: the delivery
 * endpoint keeps its behavior.
 */
export class CancelPickupOrderDto {
    @ApiProperty({
        type: String, maxLength: 500, example: 'The customer withdrew the return request.',
        description: 'Why the coordinator cancels the pickup order (the causal); kept in the audit event of the dispatch. Required; surrounding spaces are trimmed and a text of only spaces is refused',
    })
    @Transform(trim)
    @IsString({ message: 'reason must be a string.' })
    @IsNotEmpty({ message: 'reason must not be empty.' })
    @MaxLength(500, { message: 'reason must not be longer than 500 characters.' })
    reason!: string;
}
