import { Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../../shared/pipes/index.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiBadRequests, ApiForbidden, ApiIdParam, ApiNotFound, ApiConflict, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { OperationalAlertsService } from '../services/operational-alerts.service.js';
import { OperationalAlertDto } from '../dto/operational-alert.dto.js';
import { FindAllOperationalAlertsParamsDto } from '../dto/find-all-operational-alerts-params.dto.js';
import { FindAllOperationalAlertsResponseDto } from '../dto/find-all-operational-alerts-response.dto.js';

/**
 * RF-A19 (ES-66) — alertas operativas: incidencias críticas y desvíos de desempeño. Error dictionary:
 * OPERATIONAL_ALERT_NOT_FOUND 404, OPERATIONAL_ALERT_ALREADY_ACKNOWLEDGED 409, INVALID_TOKEN 401,
 * INSUFFICIENT_PERMISSIONS 403. Requires coordinator or supervisor role, or root.
 */
@ApiTags('Operational alerts')
@ApiBearerAuth('access-token')
@Controller('alerts')
export class OperationalAlertsController {
    constructor(private readonly alerts: OperationalAlertsService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'List operational alerts',
        description: '`?status=open` for the ones still pending acknowledgement (the usual case for the alerts center); omit for every alert, open or acknowledged. New ones arrive in real time over socket (`operational.alert_raised`, to `coordinator-zone:{zoneId}`/`supervisor-zone:{zoneId}`, or to every coordinator/supervisor when the alert has no zone).',
    })
    @ApiOkResponse({ type: FindAllOperationalAlertsResponseDto })
    @ApiBadRequests({ validation: true, example: ["The 'status' parameter must be one of: open, acknowledged."] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async findAll(@Query() params: FindAllOperationalAlertsParamsDto): Promise<FindAllOperationalAlertsResponseDto> {
        return await this.alerts.findAll(OperationalAlertDto, params);
    }

    @Patch(':id/acknowledge')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Acknowledge an operational alert',
        description: 'Escenario 3 de ES-66: records who acknowledged it and when, and takes it out of `?status=open` for everyone else. Only from `open` — acknowledging it twice answers 409.',
    })
    @ApiIdParam('Operational alert')
    @ApiOkResponse({ type: OperationalAlertDto })
    @ApiBadRequests({ id: true })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound({ code: 'OPERATIONAL_ALERT_NOT_FOUND', message: 'Operational alert not found.' })
    @ApiConflict({ code: 'OPERATIONAL_ALERT_ALREADY_ACKNOWLEDGED', message: 'This alert was already acknowledged.' })
    async acknowledge(
        @Param('id', ParseIdPipe) id: number,
        @CurrentUser('id') userId: number,
    ): Promise<OperationalAlertDto> {
        return await this.alerts.acknowledge(id, userId);
    }
}
