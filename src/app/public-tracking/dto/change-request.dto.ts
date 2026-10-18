import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export const CHANGE_REQUEST_MAX_LENGTH = 500;

export class ChangeRequestDto {
    @ApiProperty({
        maxLength: CHANGE_REQUEST_MAX_LENGTH,
        example: 'I will be travelling that week. I need the delivery after the 28th.',
        description: 'What the customer needs, in their own words. It is kept as an event of the delivery for the coordinator, who decides; nothing changes by itself.',
    })
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString({ message: 'detail must be a string.' })
    @IsNotEmpty({ message: 'detail must not be empty.' })
    @MaxLength(CHANGE_REQUEST_MAX_LENGTH, { message: `detail must be at most ${CHANGE_REQUEST_MAX_LENGTH} characters.` })
    detail!: string;
}
