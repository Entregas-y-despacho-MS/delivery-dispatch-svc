import { ApiProperty } from '@nestjs/swagger';

export class TwoFactorSecretDto {
    @ApiProperty({ description: 'Base32 secret, for manual entry if the QR code cannot be scanned.' })
    secret: string;

    @ApiProperty({ description: 'otpauth:// URI encoded as a QR code data URL (PNG), scannable by any authenticator app.' })
    qrCodeDataUrl: string;
}
