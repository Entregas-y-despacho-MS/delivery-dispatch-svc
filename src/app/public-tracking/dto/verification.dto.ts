import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class VerifyCodeDto {
    @ApiProperty({ example: '482913', description: 'The 6-digit code the customer received in the registered email. It is not the delivery OTP.' })
    @IsString({ message: 'code must be a string.' })
    @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits.' })
    code!: string;
}

export class VerificationCodeSentDto {
    @ApiProperty({ example: 'c***@example.test', description: 'The registered email the code was sent to, partly hidden so the customer recognises it without the page revealing it.' })
    sentTo!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the code expires (`reschedule_code_expiry_minutes` from now). Asking again issues a new code and the previous one stops working.' })
    expiresAt!: Date;
}

export class VerificationProofDto {
    @ApiProperty({ description: 'One-time proof that the code was checked. Send it in the `X-Verification-Proof` header to see the available slots and to reschedule. Keep it out of URLs and logs.' })
    proof!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the proof expires. After that a new code must be requested.' })
    expiresAt!: Date;
}
