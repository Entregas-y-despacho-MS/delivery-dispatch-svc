import { ApiProperty } from '@nestjs/swagger';
import { DispatchPriority } from './update-dispatch-priority.dto.js';

export class DispatchPriorityDto {
    @ApiProperty({ type: 'integer', example: 120, description: 'Id of the dispatch' })
    id!: number;

    @ApiProperty({ enum: DispatchPriority, example: DispatchPriority.URGENT, description: 'Priority the dispatch has after the request' })
    priority!: DispatchPriority;

    @ApiProperty({ type: String, example: 'pending', description: 'Current status of the dispatch (never changed by this operation)' })
    status!: string;
}
