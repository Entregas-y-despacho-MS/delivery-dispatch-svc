import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { CoordinatorOnly } from '../../auth/decorators/index.js';
import { SupplierPickupComplianceParamsDto } from '../dto/supplier-pickup-compliance-params.dto.js';
import { SupplierPickupComplianceDto } from '../dto/supplier-pickup-compliance.dto.js';
import { SupplierPickupComplianceService } from '../services/supplier-pickup-compliance.service.js';

/**
 * ST-305.1 (ES-305, Dashboard 5, section 5A) — compliance and exceptions of supplier-pickup appointments.
 *
 * Error dictionary: VALIDATION_FAILED 400 (missing or invalid `from`, `to`, `supplierId`, `warehouseId`, `zoneId`, `status` or `exceptionLimit`) |
 * INVALID_DATE_RANGE 400 (`from` after `to`) | DATE_RANGE_TOO_LARGE 400 (more than 366 days) | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Supplier pickup compliance')
@ApiBearerAuth('access-token')
@Controller('reports/supplier-pickups')
export class SupplierPickupComplianceController {
    constructor(private readonly service: SupplierPickupComplianceService) {}

    @Get()
    @CoordinatorOnly()
    @ApiOperation({
        summary: 'Compliance of supplier-pickup appointments and the actionable exceptions',
        description:
            "Compliance = pickups collected inside the appointment / expired appointments with a valid result. The universe is the supplier pickups whose appointment (the end of the window in force) falls between `from` and `to` (YYYY-MM-DD, both inclusive, Bolivia days); a pickup without a valid window is placed by its closing time, else by its creation. An appointment is expired when the end of its window is before the moment of the query. The moment of collection is `custodyReceivedAt` (the carrier confirmed the collection); the arrival at the warehouse and the inventory receipt are never used to measure it. Each pickup falls in exactly one category (`counts`): `onTime` (collected on or before the end of the window), `late`, `failed` (not collected, status `incident` or `not_delivered`), `openOverdue` (expired, not collected, still active), `pendingNotDue` (window not over yet, even if collected early), `cancelled`, `noValidAppointment` (window missing or ending before it starts) and `unknownTiming` (the status says it was collected but the custody time is missing: N/D, never guessed). Only `onTime`, `late` and `failed` are in the denominator: open overdue pickups are not completed and not counted as compliant, but they are listed as exceptions. `metrics.percentage` is null (N/D) with `unavailableReason` when the denominator is 0. A rescheduled pickup is measured against the window in force (the last one accepted); the original window is kept in each exception for audit, and `originalExpiredBeforeRescheduleCount` counts apart the ones rescheduled after their original window had ended. `exceptions` lists failed, open overdue, late and unknown-timing pickups, the most overdue first, up to `exceptionLimit`, with the supplier and the original window. The supplier is read from the dispatch events (there is no column for it); supplier pickups usually have no delivery zone, so the `zoneId` filter may leave nothing. Optional filters: supplier, destination warehouse, zone and current status. Not cached. Requires coordinator role, or root.",
    })
    @ApiOkResponse({ type: SupplierPickupComplianceDto })
    @ApiBadRequests({
        validation: true,
        errors: [
            { code: 'INVALID_DATE_RANGE', message: "The 'from' date must not be after the 'to' date." },
            { code: 'DATE_RANGE_TOO_LARGE', message: 'The date range must not exceed 366 days.' },
        ],
        example: ["The 'from' parameter must be a valid date in YYYY-MM-DD format.", "The 'exceptionLimit' parameter must be <= 100."],
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async getCompliance(@Query() params: SupplierPickupComplianceParamsDto): Promise<SupplierPickupComplianceDto> {
        const { exceptionLimit, ...query } = params;
        return await this.service.getCompliance(query, exceptionLimit);
    }
}
