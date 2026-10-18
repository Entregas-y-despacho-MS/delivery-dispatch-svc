import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class RescheduleDto {
    @ApiProperty({ example: '105.1792866000', description: 'The `slotId` of one of the slots listed for this delivery. The choice is checked again when it is made, so a slot that was taken meanwhile answers 409 `SLOT_NO_LONGER_AVAILABLE`.' })
    @IsString({ message: 'slotId must be a string.' })
    @Matches(/^\d{1,10}\.\d{1,12}$/, { message: 'slotId must be one of the ids returned by the list of slots.' })
    slotId!: string;
}
