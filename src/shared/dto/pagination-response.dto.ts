import { ApiProperty } from '@nestjs/swagger';

class MetadataDto {
    @ApiProperty({ description: 'Current page number', example: 1 })
    page: number;

    @ApiProperty({ description: 'Items per page', example: 10 })
    limit: number;

    @ApiProperty({ description: 'Total number of pages', example: 5 })
    pages: number;

    @ApiProperty({ description: 'Total number of records', example: 42 })
    total: number;
}

export class PaginationResponseDto<T> {
    @ApiProperty({ description: 'Items on the current page', type: Object, isArray: true })
    data: T[];

    @ApiProperty({ description: 'Pagination metadata', type: MetadataDto })
    meta: MetadataDto;
}
