import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';

// Comes from a multipart/form-data body — every field arrives as a string, hence @Type(() => Number).
export class SyncEvidenceDto {
    // Same id the client already generated for the delivery_evidences row itself — the
    // idempotency key IS the record's own PK here (see DeliveryEvidence entity).
    @ApiProperty({ example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10' })
    @IsUUID('7')
    clientEventId: string;

    @ApiProperty({ example: 42 })
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    dispatchId: number;

    @ApiProperty({ enum: ['photo', 'signature', 'otp'] })
    @IsIn(['photo', 'signature', 'otp'])
    type: string;

    @ApiPropertyOptional({ example: '123456', maxLength: 10 })
    @IsOptional()
    @IsString()
    @MaxLength(10)
    otpCode?: string;
}
