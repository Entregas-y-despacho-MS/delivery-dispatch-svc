import { Injectable } from '@nestjs/common';
import { OTP } from 'otplib';
import * as QRCode from 'qrcode';

const ISSUER = 'delivery-dispatch-svc';

// Thin wrapper over otplib's OTP class (TOTP strategy) — keeps the library's API out of
// auth.service.ts and two-factor.controller.ts.
@Injectable()
export class TwoFactorService {
    private readonly otp = new OTP({ strategy: 'totp' });

    generateSecret(): string {
        return this.otp.generateSecret();
    }

    async verify(secret: string, code: string): Promise<boolean> {
        const result = await this.otp.verify({ secret, token: code });
        return result.valid;
    }

    /** otpauth:// URI rendered as a scannable QR code (PNG data URL). */
    async generateQrCodeDataUrl(secret: string, label: string): Promise<string> {
        const uri = this.otp.generateURI({ issuer: ISSUER, label, secret });
        return QRCode.toDataURL(uri);
    }
}
