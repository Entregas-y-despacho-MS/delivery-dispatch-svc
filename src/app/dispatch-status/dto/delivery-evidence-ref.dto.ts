import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';

export const DELIVERY_EVIDENCE_TYPES = ['signature', 'photo', 'otp'] as const;
export type DeliveryEvidenceType = typeof DELIVERY_EVIDENCE_TYPES[number];

/**
 * Reference to evidence that is already registered (`POST /dispatches/:id/evidences` or `POST /dispatches/:id/otp/validate`).
 * It carries no file, no base64 and no OTP code: the backend reads the stored record and validates it.
 */
export class DeliveryEvidenceRefDto {
    @ApiProperty({ format: 'uuid', example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a11', description: 'UUID v7 of the evidence registered for this dispatch (the `evidenceId` the app sent, or the `id` returned by the OTP validation).' })
    @IsUUID('7')
    evidenceId!: string;

    @ApiProperty({ enum: DELIVERY_EVIDENCE_TYPES, example: 'signature', description: 'Evidence type the app is presenting. It must match the stored record and the dispatch evidence policy: `hand_delivery_standard` requires `signature`, `contactless_delivery` requires `photo` and `high_value_control` requires `otp`.' })
    @IsIn(DELIVERY_EVIDENCE_TYPES, { message: 'evidence.type must be one of: signature, photo, otp.' })
    type!: DeliveryEvidenceType;
}
