import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { RouteBatchSummaryDto } from './route-batch-summary.dto.js';

export class FindRouteBatchesResponseDto extends PaginationResponseDto<RouteBatchSummaryDto> {
    @ApiProperty({ type: [RouteBatchSummaryDto], description: 'Route batches of the page, ordered by shift date and id' })
    declare data: RouteBatchSummaryDto[];
}
