import { ApiProperty } from '@nestjs/swagger';

export class TwoFactorSecretDto {
    @ApiProperty({ example: 'JBSWY3DPEHPK3PXP', description: 'Base32 secret, to type by hand in the authenticator app if the QR code cannot be scanned. Keep it private' })
    secret: string;

    @ApiProperty({ description: 'otpauth:// URI encoded as a QR code data URL (PNG), scannable by any authenticator app.' })
    qrCodeDataUrl: string;
}
