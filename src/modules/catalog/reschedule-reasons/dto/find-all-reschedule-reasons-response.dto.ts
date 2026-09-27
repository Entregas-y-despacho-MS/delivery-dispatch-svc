import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { RescheduleReasonDto } from './reschedule-reason.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllRescheduleReasonsResponseDto extends PaginationResponseDto<RescheduleReasonDto> {
    @ApiProperty({ type: [RescheduleReasonDto] })
    declare data: RescheduleReasonDto[];
}
