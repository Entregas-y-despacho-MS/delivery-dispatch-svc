import { ApiProperty } from '@nestjs/swagger';
import { DriverAssignmentDto } from './driver-assignment.dto.js';

export class DriverAssignmentsResponseDto {
    @ApiProperty({ type: String, format: 'date', example: '2026-10-14', description: 'Shift date the assignments belong to (YYYY-MM-DD)' })
    date!: string;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-10-14T13:20:00.000Z', description: 'Most recent change among the listed dispatches (UTC). The mobile app compares it with its local copy to detect that Dispatch changed the route. `null` when the list is empty' })
    lastModifiedAt!: Date | null;

    @ApiProperty({ type: () => [DriverAssignmentDto], description: "The driver's stops for the day, ordered by `sequenceOrder`. Includes the ones already closed that day. Empty when the driver has no route" })
    data!: DriverAssignmentDto[];
}
