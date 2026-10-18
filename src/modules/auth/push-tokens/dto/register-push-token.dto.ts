import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PushPlatformEnum } from '../enums/push-platform.enum.js';

export class RegisterPushTokenDto {
    @ApiProperty({
        example:     'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
        maxLength:   255,
        description: 'Push token the provider (Expo or Firebase) gave to this device. Required. Sending the same device again replaces the stored token, so call this after every login and whenever the token changes',
    })
    @IsString({ message: 'Token must be a string.' })
    @IsNotEmpty({ message: 'Token must not be empty.' })
    @MaxLength(255, { message: 'Token must be at most 255 characters.' })
    token: string;

    @ApiProperty({
        enum:        PushPlatformEnum,
        example:     PushPlatformEnum.ANDROID,
        description: 'Operating system of the device. Required',
    })
    @IsEnum(PushPlatformEnum, { message: 'Platform must be ios or android.' })
    platform: PushPlatformEnum;
}
