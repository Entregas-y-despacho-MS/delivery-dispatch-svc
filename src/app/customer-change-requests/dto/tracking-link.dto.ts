import { ApiProperty } from '@nestjs/swagger';

export class TrackingLinkDto {
    @ApiProperty({ type: 'integer', description: 'Dispatch the link belongs to.' })
    dispatchId!: number;

    @ApiProperty({ example: 'https://entregas.example.com/seguimiento/5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f', description: 'The customer\'s tracking page. It is the customer\'s only credential: whoever opens it can confirm or reschedule that delivery, so it is shared only with that customer, by a channel the coordinator trusts, and never written down or logged. This request is recorded (who and when) without the link.' })
    trackingUrl!: string;
}
