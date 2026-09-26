import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min, IsOptional } from 'class-validator';

// Only there to reject absurd values: an OFFSET beyond what Postgres can compute was a 500.
const MAX_PAGE = 1_000_000;

// Query params arrive as strings — @Type(() => Number) converts them before validation.
// Requires ValidationPipe({ transform: true }) in main.ts.
export class PaginationParamsDto {
    @ApiPropertyOptional({ type: 'integer', description: 'Page number (starts at 1, up to 1000000). Default: 1.', example: 1, default: 1, minimum: 1, maximum: MAX_PAGE })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'page' parameter must be an integer." })
    @Min(1,  { message: "The 'page' parameter must be >= 1." })
    @Max(MAX_PAGE, { message: `The 'page' parameter must be <= ${MAX_PAGE}.` })
    page: number = 1;

    @ApiPropertyOptional({ type: 'integer', description: 'Results per page. Default: 10, maximum: 100.', example: 10, default: 10, minimum: 1, maximum: 100 })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'limit' parameter must be an integer." })
    @Min(1,  { message: "The 'limit' parameter must be >= 1." })
    @Max(100, { message: "The 'limit' parameter must be <= 100." })
    limit: number = 10;
}
