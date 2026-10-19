import { ApiProperty } from '@nestjs/swagger';

export class DispatchKanbanFilterOptionDto {
    @ApiProperty({ description: 'Catalog item identifier.' }) id: number;
    @ApiProperty({ description: 'Human-readable catalog label.' }) name: string;
}

export class DispatchKanbanDriverFilterOptionDto {
    @ApiProperty({ description: 'Driver user identifier.' }) id: number;
    @ApiProperty({ description: 'Driver full name.' }) fullName: string;
}

export class DispatchKanbanFiltersResponseDto {
    @ApiProperty({ type: [DispatchKanbanDriverFilterOptionDto], description: 'All active, non-deleted drivers, ordered by name.' })
    drivers: DispatchKanbanDriverFilterOptionDto[];

    @ApiProperty({ type: [DispatchKanbanFilterOptionDto], description: 'All dispatch types, ordered by name.' })
    dispatchTypes: DispatchKanbanFilterOptionDto[];
}
