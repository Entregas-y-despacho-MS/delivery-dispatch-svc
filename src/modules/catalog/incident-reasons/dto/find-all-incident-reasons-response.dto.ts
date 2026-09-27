import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { IncidentReasonDto } from './incident-reason.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllIncidentReasonsResponseDto extends PaginationResponseDto<IncidentReasonDto> {
    @ApiProperty({ type: [IncidentReasonDto] })
    declare data: IncidentReasonDto[];
}
