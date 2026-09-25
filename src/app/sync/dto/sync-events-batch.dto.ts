import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { SyncEventDto } from './sync-event.dto.js';

export class SyncEventsBatchDto {
    // Must arrive in the order the device wants them applied (FIFO) — processed as-is, never reordered.
    @ApiProperty({ type: [SyncEventDto], minItems: 1, description: 'Events in the order they happened on the device (oldest first). At least one. They are applied in exactly this order' })
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => SyncEventDto)
    events: SyncEventDto[];
}
