import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class PushTokenDeviceParamsDto {
    @ApiProperty({
        example:     'a3f1c2d4-5b6e-4f70-8a9b-0c1d2e3f4a5b',
        maxLength:   100,
        description: 'Stable identifier of the device, generated once by the mobile app and kept across logins. Together with the logged-in user it identifies one registration',
    })
    @IsString({ message: 'Device ID must be a string.' })
    @IsNotEmpty({ message: 'Device ID must not be empty.' })
    @MaxLength(100, { message: 'Device ID must be at most 100 characters.' })
    deviceId: string;
}
