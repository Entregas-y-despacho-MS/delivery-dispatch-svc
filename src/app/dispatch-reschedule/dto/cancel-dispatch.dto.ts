import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CancelDispatchDto {
    @ApiProperty({
        type: String, maxLength: 500, example: 'The package did not appear at the cotejo and the sender confirmed the loss.',
        description: 'Why the coordinator cancels the dispatch; kept in the audit event of the dispatch. Required; surrounding spaces are trimmed and a text of only spaces is refused',
    })
    @Transform(trim)
    @IsString({ message: 'reason must be a string.' })
    @IsNotEmpty({ message: 'reason must not be empty.' })
    @MaxLength(500, { message: 'reason must not be longer than 500 characters.' })
    reason!: string;
}
