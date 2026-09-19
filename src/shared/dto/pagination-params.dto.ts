import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min, IsOptional } from 'class-validator';

// Query params arrive as strings — @Type(() => Number) converts them before validation.
// Requires ValidationPipe({ transform: true }) in main.ts.
export class PaginationParamsDto {
    @ApiPropertyOptional({ description: 'Page number (starts at 1). Default: 1.', example: 2, default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'page' parameter must be an integer." })
    @Min(1,  { message: "The 'page' parameter must be >= 1." })
    page: number = 1;

    @ApiPropertyOptional({ description: 'Results per page. Default: 10.', example: 20, default: 10 })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'limit' parameter must be an integer." })
    @Min(1,  { message: "The 'limit' parameter must be >= 1." })
    limit: number = 10;
}
