import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import {
  ApiBadRequests,
  ApiUnauthorized,
} from '../../../../shared/utils/swagger/index.js';
import { AuditLogsService } from '../services/audit-logs.service.js';
import {
  PaginationParamsDto,
  PaginationResponseDto,
} from '../../../../shared/dto/index.js';
import { OutboundMessageAlertDto } from '../dto/outbound-message-alert.dto.js';
import { FindOutboundMessageAlertsResponseDto } from '../dto/find-outbound-message-alerts-response.dto.js';

@ApiTags('Audit Logs')
@ApiBearerAuth('access-token')
@Controller('audit')
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get('outbound-message-alerts')
  @Roles(RoleEnum.COORDINATOR)
  @ApiOperation({
    summary: 'List outbox alerts',
    description:
      'Returns a paginated, newest-first list of delayed and failed outbound-message alerts, including each message’s current outbox status and attempt count when available. Requires coordinator role, or root.',
  })
  @ApiBadRequests({
    validation: true,
    example: ["The 'limit' parameter must be <= 100."],
  })
  @ApiOkResponse({ type: FindOutboundMessageAlertsResponseDto })
  @ApiUnauthorized({
    code: 'INVALID_TOKEN',
    message: 'Invalid or expired token.',
  })
  async findOutboundMessageAlerts(
    @Query() params: PaginationParamsDto,
  ): Promise<PaginationResponseDto<OutboundMessageAlertDto>> {
    return await this.auditLogsService.findOutboundMessageAlerts(params);
  }
}
