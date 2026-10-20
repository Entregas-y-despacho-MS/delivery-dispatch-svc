import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CancelDispatchDto {
    @ApiProperty({
        type: String, maxLength: 500, example: 'The package did not appear at the cotejo and the sender confirmed the loss.',
        description: 'Why the coordinator cancels the dispatch; kept in the audit event of the dispatch. Required',
    })
    @IsString({ message: 'reason must be a string.' })
    @IsNotEmpty({ message: 'reason must not be empty.' })
    @MaxLength(500, { message: 'reason must not be longer than 500 characters.' })
    reason!: string;
}
