import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../shared/dto/index.js';
import { OperationalAlertDto } from './operational-alert.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllOperationalAlertsResponseDto extends PaginationResponseDto<OperationalAlertDto> {
    @ApiProperty({ type: [OperationalAlertDto] })
    declare data: OperationalAlertDto[];
}
