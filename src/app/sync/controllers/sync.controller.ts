/// <reference types="multer" />
import { Body, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SyncService } from '../services/sync.service.js';
import { SyncEventsBatchDto } from '../dto/sync-events-batch.dto.js';
import { SyncEventsBatchResultDto, SyncEventResultDto } from '../dto/sync-event-result.dto.js';
import { SyncEvidenceDto } from '../dto/sync-evidence.dto.js';
import { DriverOnly } from '../../auth/decorators/index.js';
import { ApiUnauthorized, ApiValidationError } from '../../../shared/utils/swagger/index.js';

/**
 * RF-U13 — sincronización offline de la app móvil del repartidor. Cada evento trae su propio
 * clientEventId (UUID v7) generado en el dispositivo mientras estaba sin conexión — reintentar
 * el mismo evento nunca lo duplica, la respuesta siempre indica "applied" o "already_processed"
 * por evento, nunca un error genérico de todo el lote.
 *
 * Error dictionary: DISPATCH_NOT_FOUND 404 (reportado por evento dentro del resultado, no como
 * error HTTP del batch completo) | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Sync')
@ApiBearerAuth('access-token')
@Controller('sync')
export class SyncController {
    constructor(private readonly syncService: SyncService) {}

    @Post('events')
    @DriverOnly()
    @ApiOperation({
        summary:     'Sync a batch of offline status-change/incident events',
        description: 'Applies the batch in the exact order received (FIFO). Idempotent per event via clientEventId — a retried event responds "already_processed", never a duplicate. Requires driver role.',
    })
    @ApiCreatedResponse({ type: SyncEventsBatchResultDto })
    @ApiValidationError()
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async syncEvents(@Body() dto: SyncEventsBatchDto): Promise<SyncEventsBatchResultDto> {
        return await this.syncService.processBatch(dto.events);
    }

    @Post('evidences')
    @DriverOnly()
    @UseInterceptors(FileInterceptor('file'))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({
        summary:     'Sync a delivery evidence (photo/signature/OTP)',
        description: 'Uploads the file (if any) via the storage plugin and records the evidence. Idempotent via clientEventId (the record\'s own id). Requires driver role.',
    })
    @ApiBody({
        schema: {
            type:       'object',
            properties: {
                file:          { type: 'string', format: 'binary' },
                clientEventId: { type: 'string', example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10' },
                dispatchId:    { type: 'integer', example: 42 },
                type:          { type: 'string', enum: ['photo', 'signature', 'otp'] },
                otpCode:       { type: 'string', example: '123456' },
            },
            required: ['clientEventId', 'dispatchId', 'type'],
        },
    })
    @ApiCreatedResponse({ type: SyncEventResultDto })
    @ApiValidationError()
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async syncEvidence(
        @Body() dto: SyncEvidenceDto,
        @UploadedFile() file?: Express.Multer.File,
    ): Promise<SyncEventResultDto> {
        return await this.syncService.syncEvidence(dto, file);
    }
}
