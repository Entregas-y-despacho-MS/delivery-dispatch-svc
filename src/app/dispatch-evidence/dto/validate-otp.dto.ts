import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class ValidateOtpDto {
    @ApiProperty({ example: '123456', pattern: '^\\d{4,10}$', description: 'The numeric code the customer received by SMS (4 to 10 digits; its length is the `otp_code_length` setting). A value that is not only digits is rejected with 400 and does not count as an attempt.' })
    @Matches(/^\d{4,10}$/, { message: 'code must be 4 to 10 digits' })
    code: string;
}
