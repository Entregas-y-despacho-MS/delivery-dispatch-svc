import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';

export enum DispatchPriority {
    URGENT = 'urgent',
    NORMAL = 'normal',
}

export class UpdateDispatchPriorityDto {
    @ApiProperty({
        enum: DispatchPriority,
        example: DispatchPriority.URGENT,
        description: 'New priority of the dispatch. `urgent` only moves it to the front of the queue of free capacity: it never changes the deadline, the delivery window or the 12 h customer window, and it does not displace promises already approved (D-15). Sending the current value is accepted and changes nothing',
    })
    @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
    @IsIn(Object.values(DispatchPriority), { message: "The 'priority' field must be one of: urgent, normal." })
    priority!: DispatchPriority;
}
