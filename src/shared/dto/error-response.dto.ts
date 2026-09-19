import { ApiProperty } from '@nestjs/swagger';

// Standard shape of all API error responses produced by HttpExceptionFilter.
export class ErrorResponseDto {
    @ApiProperty({ description: 'HTTP status code', example: 404 })
    statusCode: number;

    @ApiProperty({
        description: 'Machine-readable error code. Domain errors use SCREAMING_SNAKE_CASE.',
        example: 'NOT_FOUND',
        examples: {
            generic:    { value: 'NOT_FOUND',         summary: 'Generic NestJS exception' },
            domain:     { value: 'USER_NOT_FOUND',    summary: 'Domain-specific error' },
            auth:       { value: 'INVALID_TOKEN',     summary: 'Authentication error' },
            permission: { value: 'PERMISSION_DENIED', summary: 'Authorization error' },
        },
    })
    error: string;

    @ApiProperty({
        description: 'Human-readable message or list of validation errors.',
        oneOf: [
            { type: 'string',  example: 'User not found.' },
            { type: 'array', items: { type: 'string' }, example: ['name must be a string'] },
        ],
    })
    message: string | string[];

    @ApiProperty({ description: 'Endpoint path that triggered the error', example: '/api/users/1' })
    path: string;

    @ApiProperty({ description: 'ISO 8601 timestamp', example: '2024-01-01T00:00:00.000Z' })
    timestamp: string;
}
