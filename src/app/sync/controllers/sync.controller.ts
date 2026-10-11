/// <reference types="multer" />
import { BadRequestException, Body, Controller, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiCreatedResponse, ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type { Response } from 'express';
import { SyncService } from '../services/sync.service.js';
import { SyncEventsBatchDto } from '../dto/sync-events-batch.dto.js';
import { SyncEventsBatchResultDto, SyncEventResultDto } from '../dto/sync-event-result.dto.js';
import { SyncEvidenceDto } from '../dto/sync-evidence.dto.js';
import { DriverOnly } from '../../auth/decorators/index.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { ApiUnauthorized, ApiBadRequests } from '../../../shared/utils/swagger/index.js';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { SETTINGS_VERSION_HEADER } from '../../../modules/settings/settings.constants.js';

/**
 * RF-U13 — sincronización offline de la app móvil del repartidor. Cada evento trae su propio
 * clientEventId (UUID v7) generado en el dispositivo mientras estaba sin conexión — reintentar
 * el mismo evento nunca lo duplica, la respuesta siempre indica "applied" o "already_processed"
 * por evento, nunca un error genérico de todo el lote.
 *
 * Error dictionary: DISPATCH_NOT_FOUND 404 (reportado por evento dentro del resultado, no como
 * error HTTP del batch completo) | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
const MAX_EVIDENCE_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EVIDENCE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

@ApiTags('Sync')
@ApiBearerAuth('access-token')
@Controller('sync')
export class SyncController {
    constructor(
        private readonly syncService: SyncService,
        private readonly settingsService: SettingsService,
    ) {}

    @Post('events')
    @DriverOnly()
    @ApiOperation({
        summary:     'Sync a batch of offline status-change/incident events',
        description: 'Used by the driver\'s mobile app to upload what happened while offline. Send the events in the order they occurred: they are applied one by one in exactly that order (FIFO) and never reordered. Each event carries its own `clientEventId` (a UUID v7 generated on the device), which makes the call safe to retry: an event already applied answers `already_processed` instead of being duplicated. The HTTP status is 201 even when some events fail: read `results`, where each event reports `applied`, `already_processed` or `failed` (with an `error` text, e.g. dispatch not found), and a failed event does not stop the ones after it. The device should keep only the failed ones for the next retry. A driver can only sync events of dispatches on a route assigned to them: any other dispatch id (unknown or someone else\'s) is reported as `failed` with "Dispatch not found.". Requires driver role.',
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
        headers: { [SETTINGS_VERSION_HEADER]: { description: 'Current operational settings version. Reload settings when this value changes.', schema: { type: 'integer' } } },
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
    async syncEvents(
        @Body() dto: SyncEventsBatchDto,
        @CurrentUser('id') driverId: number,
        @Res({ passthrough: true }) response: Response,
    ): Promise<SyncEventsBatchResultDto> {
        const result = await this.syncService.processBatch(dto.events, driverId);
        response.setHeader(SETTINGS_VERSION_HEADER, String(await this.settingsService.getVersion()));
        return result;
    }

    @Post('evidences')
    @DriverOnly()
    @UseInterceptors(FileInterceptor('file', {
        // Without limits multer buffers the whole upload in memory: any driver could exhaust it.
        limits: { fileSize: MAX_EVIDENCE_FILE_BYTES, files: 1 },
        // Only images: the local storage serves uploads from this server's own origin, so an uploaded
        // .html or .svg would run as a page of the API.
        fileFilter: (_req, file, cb) => {
            if (ALLOWED_EVIDENCE_MIME.has(file.mimetype)) return cb(null, true);
            cb(new BadRequestException('The file must be an image (jpeg, png, webp, heic or heif).'), false);
        },
    }))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({
        summary:     'Sync a delivery evidence (photo/signature/OTP)',
        description: 'Used by the driver\'s mobile app to upload a delivery evidence. Sent as `multipart/form-data`: `clientEventId` (UUID v7, also the evidence\'s own ID, so a retry is safe), `dispatchId`, `type` (photo | signature | otp), plus the `file` (typically for photo and signature) or the `otpCode` (typically for otp). The file must be an image (jpeg, png, webp, heic, heif) of at most 10 MB, otherwise 400 (413 when too big). A photo or signature needs its `file` and an otp needs its `otpCode`, otherwise the result is `failed`. Answers 201 with a single result: `applied`, `already_processed`, or `failed` with an `error` (e.g. dispatch not found). Requires driver role.',
    })
    @ApiBody({
        schema: {
            type:       'object',
            properties: {
                file:          { type: 'string', format: 'binary', description: 'The photo or signature image (jpeg, png, webp, heic or heif, up to 10 MB). Required for photo and signature; not needed for an otp evidence' },
                clientEventId: { type: 'string', example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', description: 'UUID v7 generated by the device; it becomes the evidence ID, so a retry is safe' },
                dispatchId:    { type: 'integer', example: 42, description: 'ID of the dispatch this evidence belongs to' },
                type:          { type: 'string', enum: ['photo', 'signature', 'otp'], description: 'Kind of evidence' },
                otpCode:       { type: 'string', example: '123456', maxLength: 10, description: 'The OTP code the recipient gave. Required when type = otp' },
            },
            required: ['clientEventId', 'dispatchId', 'type'],
        },
    })
    @ApiBadRequests({ validation: true, example: ['clientEventId must be a UUID'] })
    @ApiResponse({
        status: 413,
        description: 'The uploaded evidence file exceeds the 10 MB limit.',
        schema: {
            type: 'object',
            properties: {
                statusCode: { type: 'integer', example: 413 },
                error:      { type: 'string', example: 'HTTP_ERROR' },
                message:    { type: 'string', example: 'File too large' },
                path:       { type: 'string', example: '/api/sync/evidences' },
                timestamp:  { type: 'string', format: 'date-time', example: '2026-10-11T00:00:00.000Z' },
            },
        },
    })
    @ApiExtraModels(SyncEventResultDto)
    @ApiCreatedResponse({
        description: 'Read `outcome`: 201 does not mean the evidence was saved.',
        headers: { [SETTINGS_VERSION_HEADER]: { description: 'Current operational settings version. Reload settings when this value changes.', schema: { type: 'integer' } } },
        content: { 'application/json': { schema: { $ref: getSchemaPath(SyncEventResultDto) }, examples: {
            applied:           { summary: 'Saved now', value: { clientEventId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', outcome: 'applied' } },
            already_processed: { summary: 'Saved by an earlier attempt, nothing changed', value: { clientEventId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', outcome: 'already_processed' } },
            failed:            { summary: 'Not saved', value: { clientEventId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', outcome: 'failed', error: 'Dispatch not found.' } },
        } } },
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async syncEvidence(
        @Body() dto: SyncEvidenceDto,
        @CurrentUser('id') driverId: number,
        @Res({ passthrough: true }) response: Response,
        @UploadedFile() file?: Express.Multer.File,
    ): Promise<SyncEventResultDto> {
        const result = await this.syncService.syncEvidence(dto, file, driverId);
        response.setHeader(SETTINGS_VERSION_HEADER, String(await this.settingsService.getVersion()));
        return result;
    }
}
