import { ApiProperty } from '@nestjs/swagger';

// Shape of a 400 validation error produced by ValidationPipe.
// message is an array — one entry per invalid field.
export class ValidationExceptionDto {
    @ApiProperty({ example: 400 })
    statusCode: number;

    @ApiProperty({ example: 'BAD_REQUEST' })
    error: string;

    @ApiProperty({
        description: 'One validation error message per invalid field.',
        type: [String],
        example: ['title must be a string', 'title should not be empty'],
    })
    message: string[];

    @ApiProperty({ example: '/api/examples' })
    path: string;

    @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
    timestamp: string;
}
