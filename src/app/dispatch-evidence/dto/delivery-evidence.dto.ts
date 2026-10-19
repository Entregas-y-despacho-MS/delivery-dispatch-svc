import { ApiProperty } from '@nestjs/swagger';

/** What the app gets back. The stored file URL is not part of it: the control tower reads it through a signed link. */
export class DeliveryEvidenceDto {
    @ApiProperty({ example: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10', description: 'Evidence ID, the one the device sent.' })
    id: string;

    @ApiProperty({ type: 'integer', example: 42, description: 'Dispatch the evidence belongs to.' })
    dispatchId: number;

    @ApiProperty({ enum: ['signature', 'photo', 'otp'], description: 'Kind of evidence.' })
    type: string;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-10-18T14:03:00.000Z', description: 'When the device captured it. `null` for an OTP evidence.' })
    capturedAt: Date | null;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, example: -17.783327, description: 'Capture latitude. `null` when not provided.' })
    latitude: number | null;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, example: -63.18214, description: 'Capture longitude. `null` when not provided.' })
    longitude: number | null;

    @ApiProperty({ type: String, nullable: true, example: 'Maria Lopez', description: 'Who received the order. Only for a signature, otherwise `null`.' })
    receiverName: string | null;

    @ApiProperty({ type: String, nullable: true, example: '1234567', description: 'ID document of who received the order. Only for a signature, otherwise `null`.' })
    receiverDocument: string | null;

    @ApiProperty({ type: String, format: 'date-time', example: '2026-10-18T14:05:00.000Z', description: 'When the server registered the evidence.' })
    createdAt: Date;
}
