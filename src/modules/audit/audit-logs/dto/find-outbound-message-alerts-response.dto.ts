import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { OutboundMessageAlertDto } from './outbound-message-alert.dto.js';

export class FindOutboundMessageAlertsResponseDto extends PaginationResponseDto<OutboundMessageAlertDto> {
  @ApiProperty({
    type: [OutboundMessageAlertDto],
    description: 'Outbox alerts, newest first.',
  })
  declare data: OutboundMessageAlertDto[];
}
