import { ApiProperty } from '@nestjs/swagger';

class MetadataDto {
    @ApiProperty({ type: 'integer', description: 'Current page number', example: 1 })
    page: number;

    @ApiProperty({ type: 'integer', description: 'Items per page', example: 10 })
    limit: number;

    @ApiProperty({ type: 'integer', description: 'Total number of pages (0 when there are no results)', example: 5 })
    pages: number;

    @ApiProperty({ type: 'integer', description: 'Total number of records matching the filters', example: 42 })
    total: number;
}

export class PaginationResponseDto<T> {
    @ApiProperty({ description: 'Items on the current page', type: Object, isArray: true })
    data: T[];

    @ApiProperty({ description: 'Pagination metadata', type: MetadataDto })
    meta: MetadataDto;
}
