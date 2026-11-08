import { Body, Controller, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DriverOnly } from '../auth/decorators/index.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../shared/pipes/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized, ApiUnprocessableEntity } from '../../shared/utils/swagger/index.js';
import { SETTINGS_VERSION_HEADER } from '../../modules/settings/settings.constants.js';
import { SettingsService } from '../../modules/settings/services/settings.service.js';
import { RegisterSupplierPickupDto } from './dto/register-supplier-pickup.dto.js';
import { ArrivedAtWarehouseDto } from './dto/arrived-at-warehouse.dto.js';
import { RegisterReturnPickupDto } from './dto/register-return-pickup.dto.js';
import { ArrivedAtWarehouseResponseDto, ReturnPickupResponseDto, SupplierPickupResponseDto } from './dto/supplier-pickup-response.dto.js';
import { ReturnPickupService } from './return-pickup.service.js';
import { SupplierPickupService } from './supplier-pickup.service.js';

@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches')
export class SupplierPickupController {
    constructor(
        private readonly pickups: SupplierPickupService,
        private readonly returnPickups: ReturnPickupService,
        private readonly settings: SettingsService,
    ) {}

    @Post(':id/supplier-pickup')
    @HttpCode(HttpStatus.OK)
    @DriverOnly()
    @ApiIdParam('Dispatch')
    @ApiOperation({
        summary: 'Register the goods collected at a supplier pickup',
        description: 'The assigned driver confirms the quantities received against the ones expected for a supplier_pickup dispatch, which moves to picked_up_in_transit. A quantity difference requires reasonCode and a photo already uploaded for this dispatch, and raises an incident reported to Compras. eventId makes retries idempotent.',
    })
    @ApiOkResponse({ type: SupplierPickupResponseDto, description: 'The pickup was registered (or this eventId was already processed; the original result is returned).', headers: { [SETTINGS_VERSION_HEADER]: { description: 'Current operational settings version. Reload settings when this value changes.', schema: { type: 'integer' } } } })
    @ApiBadRequests({ validation: true, id: true, example: ['eventId must be a UUID v7', 'items should not be empty'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'Dispatch is not assigned to your route.' })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' }, { code: 'INCIDENT_REASON_NOT_FOUND', message: 'Incident reason not found or inactive.' })
    @ApiConflict(
        { code: 'DISPATCH_NOT_SUPPLIER_PICKUP', message: 'This endpoint only applies to a supplier pickup.' },
        { code: 'DISPATCH_NOT_IN_TRANSIT', message: 'A supplier pickup can only be collected while in_transit.' },
        { code: 'SUPPLIER_PICKUP_ITEMS_MISMATCH', message: 'items must match exactly the items expected for this pickup.' },
        { code: 'EVENT_ID_ALREADY_USED', message: 'This eventId was already used for another event.' },
    )
    @ApiUnprocessableEntity(
        { code: 'SUPPLIER_PICKUP_EVIDENCE_REQUIRED', message: 'A reasonCode and a photo already registered for this dispatch are required when a received quantity differs from the expected one.' },
        { code: 'SUPPLIER_PICKUP_SIGNATURE_REQUIRED', message: 'signatureId must reference a signature already registered for this dispatch.' },
    )
    async registerCollection(
        @Param('id', ParseIdPipe) dispatchId: number,
        @CurrentUser('id') driverId: number,
        @Body() dto: RegisterSupplierPickupDto,
        @Res({ passthrough: true }) response: Response,
    ): Promise<SupplierPickupResponseDto> {
        const result = await this.pickups.registerCollection(dispatchId, driverId, dto);
        response.setHeader(SETTINGS_VERSION_HEADER, String(await this.settings.getVersion()));
        return result;
    }

    @Post(':id/return-pickup')
    @HttpCode(HttpStatus.OK)
    @DriverOnly()
    @ApiIdParam('Dispatch')
    @ApiOperation({
        summary: 'Register the collection of a customer return pickup',
        description: 'The assigned driver registers the physical inspection (3-point checklist, observations mandatory when any point is unchecked), with the photo and the customer signature already uploaded for this dispatch. The warehouse_return_pickup dispatch moves from in_transit to picked_up_in_transit. eventId makes retries idempotent. The arrival at the warehouse is then registered with POST /dispatches/:id/arrived-at-warehouse.',
    })
    @ApiOkResponse({ type: ReturnPickupResponseDto, description: 'The pickup was registered (or this eventId was already processed; the original result is returned).', headers: { [SETTINGS_VERSION_HEADER]: { description: 'Current operational settings version. Reload settings when this value changes.', schema: { type: 'integer' } } } })
    @ApiBadRequests({ validation: true, id: true, example: ['eventId must be a UUID v7', 'checklist.completeParts must be a boolean value'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'Dispatch is not assigned to your route.' })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' })
    @ApiConflict(
        { code: 'DISPATCH_NOT_RETURN_PICKUP', message: 'This endpoint only applies to a customer return pickup (warehouse_return_pickup).' },
        { code: 'DISPATCH_NOT_IN_TRANSIT', message: 'A return pickup can only be collected while in_transit.' },
        { code: 'EVENT_ID_ALREADY_USED', message: 'This eventId was already used for another event.' },
    )
    @ApiUnprocessableEntity(
        { code: 'RETURN_PICKUP_OBSERVATIONS_REQUIRED', message: 'observations are required when any checklist point is unchecked.' },
        { code: 'RETURN_PICKUP_PHOTO_REQUIRED', message: 'photoId must reference a photo already registered for this dispatch.' },
        { code: 'RETURN_PICKUP_SIGNATURE_REQUIRED', message: 'signatureId must reference a signature already registered for this dispatch.' },
    )
    async registerReturnPickup(
        @Param('id', ParseIdPipe) dispatchId: number,
        @CurrentUser('id') driverId: number,
        @Body() dto: RegisterReturnPickupDto,
        @Res({ passthrough: true }) response: Response,
    ): Promise<ReturnPickupResponseDto> {
        const result = await this.returnPickups.registerCollection(dispatchId, driverId, dto);
        response.setHeader(SETTINGS_VERSION_HEADER, String(await this.settings.getVersion()));
        return result;
    }

    @Post(':id/arrived-at-warehouse')
    @HttpCode(HttpStatus.OK)
    @DriverOnly()
    @ApiIdParam('Dispatch')
    @ApiOperation({
        summary: 'Register the driver’s arrival at the destination warehouse',
        description: 'The assigned driver marks arrival at the destination warehouse for a picked_up_in_transit supplier pickup. Does not change the dispatch status; Inventarios still receives dispatch.transfer.status_changed. eventId makes retries idempotent.',
    })
    @ApiOkResponse({ type: ArrivedAtWarehouseResponseDto, description: 'The arrival was registered (or this eventId was already processed; the original result is returned).', headers: { [SETTINGS_VERSION_HEADER]: { description: 'Current operational settings version. Reload settings when this value changes.', schema: { type: 'integer' } } } })
    @ApiBadRequests({ validation: true, id: true, example: ['eventId must be a UUID v7'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'Dispatch is not assigned to your route.' })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' })
    @ApiConflict(
        { code: 'DISPATCH_NOT_SUPPLIER_PICKUP', message: 'This endpoint only applies to a supplier pickup.' },
        { code: 'DISPATCH_NOT_PICKED_UP', message: 'The warehouse arrival can only be registered after the pickup was collected.' },
        { code: 'WAREHOUSE_ARRIVAL_ALREADY_REGISTERED', message: 'The arrival at the warehouse was already registered for this dispatch.' },
        { code: 'EVENT_ID_ALREADY_USED', message: 'This eventId was already used for another event.' },
    )
    async registerArrival(
        @Param('id', ParseIdPipe) dispatchId: number,
        @CurrentUser('id') driverId: number,
        @Body() dto: ArrivedAtWarehouseDto,
        @Res({ passthrough: true }) response: Response,
    ): Promise<ArrivedAtWarehouseResponseDto> {
        const result = await this.pickups.registerArrival(dispatchId, driverId, dto);
        response.setHeader(SETTINGS_VERSION_HEADER, String(await this.settings.getVersion()));
        return result;
    }
}
