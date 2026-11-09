import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, Matches } from 'class-validator';

const dateMessage = (name: string) => `The '${name}' parameter must be a valid date in YYYY-MM-DD format.`;

export class FleetReportsParamsDto {
    @ApiProperty({ type: String, format: 'date', description: 'First Bolivia day of the range, inclusive (YYYY-MM-DD)' })
    @IsDateString({ strict: true }, { message: dateMessage('from') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: dateMessage('from') })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last Bolivia day of the range, inclusive (YYYY-MM-DD); from must not be after to and the range must not exceed 366 days' })
    @IsDateString({ strict: true }, { message: dateMessage('to') })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: dateMessage('to') })
    to!: string;
}
