/// <reference types="multer" />
import { Body, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiCreatedResponse, ApiExtraModels, ApiOperation, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { SyncService } from '../services/sync.service.js';
import { SyncEventsBatchDto } from '../dto/sync-events-batch.dto.js';
import { SyncEventsBatchResultDto, SyncEventResultDto } from '../dto/sync-event-result.dto.js';
import { SyncEvidenceDto } from '../dto/sync-evidence.dto.js';
import { DriverOnly } from '../../auth/decorators/index.js';
import { ApiUnauthorized, ApiBadRequests } from '../../../shared/utils/swagger/index.js';

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
        description: 'Used by the driver\'s mobile app to upload what happened while offline. Send the events in the order they occurred: they are applied one by one in exactly that order (FIFO) and never reordered. Each event carries its own `clientEventId` (a UUID v7 generated on the device), which makes the call safe to retry: an event already applied answers `already_processed` instead of being duplicated. The HTTP status is 201 even when some events fail: read `results`, where each event reports `applied`, `already_processed` or `failed` (with an `error` text, e.g. dispatch not found), and a failed event does not stop the ones after it. The device should keep only the failed ones for the next retry. Requires driver role.',
    })
    @ApiBody({
        type: SyncEventsBatchDto,
        examples: {
            offline_route: {
                summary: 'A status change followed by an incident, both made while offline',
                value: {
                    events: [
                        { type: 'status_change', clientEventId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', dispatchId: 42, occurredAt: '2026-09-22T14:03:00.000Z', dispatchStatusId: 2, detail: 'Left the warehouse' },
                        { type: 'incident', clientEventId: '01933b6e-9c41-7b02-8e5d-3a7f1b2c6d44', dispatchId: 42, occurredAt: '2026-09-22T14:41:00.000Z', incidentReasonId: 2, detail: 'Client not at home' },
                    ],
                },
            },
        },
    })
    @ApiBadRequests({ validation: true, example: ['events must contain at least 1 elements'] })
    @ApiExtraModels(SyncEventsBatchResultDto)
    @ApiCreatedResponse({
        description: 'The batch was processed. Read each result: 201 does not mean every event was saved.',
        content: { 'application/json': { schema: { $ref: getSchemaPath(SyncEventsBatchResultDto) }, examples: {
            mixed: {
                summary: 'One event saved, one was already saved before, one failed',
                value: { results: [
                    { clientEventId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', outcome: 'applied' },
                    { clientEventId: '01933b6e-9c41-7b02-8e5d-3a7f1b2c6d44', outcome: 'already_processed' },
                    { clientEventId: '01933b6e-b3d0-7e11-a4c2-5d9e8f7a1b23', outcome: 'failed', error: 'Dispatch not found.' },
                ] },
            },
        } } },
    })
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
        description: 'Used by the driver\'s mobile app to upload a delivery evidence. Sent as `multipart/form-data`: `clientEventId` (UUID v7, also the evidence\'s own ID, so a retry is safe), `dispatchId`, `type` (photo | signature | otp), plus the `file` (typically for photo and signature) or the `otpCode` (typically for otp). Answers 201 with a single result: `applied`, `already_processed`, or `failed` with an `error` (e.g. dispatch not found). Requires driver role.',
    })
    @ApiBody({
        schema: {
            type:       'object',
            properties: {
                file:          { type: 'string', format: 'binary', description: 'The photo or signature image. Not needed for an otp evidence' },
                clientEventId: { type: 'string', example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', description: 'UUID v7 generated by the device; it becomes the evidence ID, so a retry is safe' },
                dispatchId:    { type: 'integer', example: 42, description: 'ID of the dispatch this evidence belongs to' },
                type:          { type: 'string', enum: ['photo', 'signature', 'otp'], description: 'Kind of evidence' },
                otpCode:       { type: 'string', example: '123456', maxLength: 10, description: 'The OTP code the recipient gave. Used when type = otp' },
            },
            required: ['clientEventId', 'dispatchId', 'type'],
        },
    })
    @ApiBadRequests({ validation: true, example: ['clientEventId must be a UUID'] })
    @ApiExtraModels(SyncEventResultDto)
    @ApiCreatedResponse({
        description: 'Read `outcome`: 201 does not mean the evidence was saved.',
        content: { 'application/json': { schema: { $ref: getSchemaPath(SyncEventResultDto) }, examples: {
            applied:           { summary: 'Saved now', value: { clientEventId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', outcome: 'applied' } },
            already_processed: { summary: 'Saved by an earlier attempt, nothing changed', value: { clientEventId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', outcome: 'already_processed' } },
            failed:            { summary: 'Not saved', value: { clientEventId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', outcome: 'failed', error: 'Dispatch not found.' } },
        } } },
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async syncEvidence(
        @Body() dto: SyncEvidenceDto,
        @UploadedFile() file?: Express.Multer.File,
    ): Promise<SyncEventResultDto> {
        return await this.syncService.syncEvidence(dto, file);
    }
}
