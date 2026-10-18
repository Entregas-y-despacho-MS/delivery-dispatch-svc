// RF-U10 — RegisterPushTokenDto y PushTokenDeviceParamsDto: lo que la app móvil puede enviar.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PushTokenDeviceParamsDto } from './push-token-device-params.dto.js';
import { RegisterPushTokenDto } from './register-push-token.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };
const errorsOf = async <T extends object>(cls: new () => T, plain: object) =>
    (await validate(plainToInstance(cls, plain), OPTIONS)).map((e) => e.property);

describe('RegisterPushTokenDto', () => {
    it.each(['ios', 'android'])('acepta platform = %s', async (platform) => {
        expect(await errorsOf(RegisterPushTokenDto, { token: 'ExponentPushToken[abc]', platform })).toEqual([]);
    });

    it.each(['web', 'IOS', '', 1, null])('rechaza platform = %j', async (platform) => {
        expect(await errorsOf(RegisterPushTokenDto, { token: 'abc', platform })).toEqual(['platform']);
    });

    it.each(['', 1, null, {}])('rechaza token = %j', async (token) => {
        expect(await errorsOf(RegisterPushTokenDto, { token, platform: 'ios' })).toEqual(['token']);
    });

    it('acepta un token de 255 caracteres y rechaza uno de 256 (la columna es VARCHAR(255))', async () => {
        expect(await errorsOf(RegisterPushTokenDto, { token: 'a'.repeat(255), platform: 'ios' })).toEqual([]);
        expect(await errorsOf(RegisterPushTokenDto, { token: 'a'.repeat(256), platform: 'ios' })).toEqual(['token']);
    });

    it('rechaza un body vacío y campos desconocidos (el dueño nunca viene en el body)', async () => {
        expect((await errorsOf(RegisterPushTokenDto, {})).sort()).toEqual(['platform', 'token']);
        expect(await errorsOf(RegisterPushTokenDto, { token: 'abc', platform: 'ios', userId: 1 })).toEqual(['userId']);
    });
});

describe('PushTokenDeviceParamsDto', () => {
    it('acepta un deviceId de hasta 100 caracteres (la columna es VARCHAR(100))', async () => {
        expect(await errorsOf(PushTokenDeviceParamsDto, { deviceId: 'a'.repeat(100) })).toEqual([]);
        expect(await errorsOf(PushTokenDeviceParamsDto, { deviceId: 'a'.repeat(101) })).toEqual(['deviceId']);
    });

    it('rechaza un deviceId vacío', async () => {
        expect(await errorsOf(PushTokenDeviceParamsDto, { deviceId: '' })).toEqual(['deviceId']);
    });
});
