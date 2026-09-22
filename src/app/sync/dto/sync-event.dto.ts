import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { SyncEventType } from './sync-event-type.enum.js';

export class SyncEventDto {
    @ApiProperty({ enum: SyncEventType })
    @IsEnum(SyncEventType)
    type: SyncEventType;

    // UUID v7 (not v4) — generated on-device before the event ever reaches the backend, this is
    // the idempotency key for the whole sync mechanism (RF-U13, Escenario 3).
    @ApiProperty({ example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', description: 'UUID v7 generado por el dispositivo — clave de idempotencia' })
    @IsUUID('7')
    clientEventId: string;

    @ApiProperty({ example: 42 })
    @IsInt()
    @IsPositive()
    dispatchId: number;

    // The device's own UTC clock when the change actually happened — not when it finally synced.
    @ApiProperty({ example: '2026-09-22T14:03:00.000Z', description: 'Momento real en que ocurrió en el dispositivo (UTC)' })
    @IsDateString()
    occurredAt: string;

    @ApiPropertyOptional({ example: 3, description: 'Requerido cuando type = status_change' })
    @ValidateIf((o: SyncEventDto) => o.type === SyncEventType.STATUS_CHANGE)
    @IsInt()
    @IsPositive()
    dispatchStatusId?: number;

    @ApiPropertyOptional({ example: 2, description: 'Requerido cuando type = incident' })
    @ValidateIf((o: SyncEventDto) => o.type === SyncEventType.INCIDENT)
    @IsInt()
    @IsPositive()
    incidentReasonId?: number;

    @ApiPropertyOptional({ maxLength: 1000, description: 'Detalle libre (motivo del cambio de estado, o descripción de la incidencia)' })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    detail?: string;
}
