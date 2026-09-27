// RF-A27 — UpdateUserRoleDto: a diferencia de UpdateUserDto, roleId es obligatorio (este endpoint
// solo existe para cambiar el rol).
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateUserRoleDto } from './update-user-role.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };
const errorsOf = async (plain: object) =>
    (await validate(plainToInstance(UpdateUserRoleDto, plain), OPTIONS)).map((e) => e.property);

describe('UpdateUserRoleDto', () => {
    it('acepta un roleId válido', async () => {
        expect(await errorsOf({ roleId: 2 })).toEqual([]);
    });

    it.each([undefined, null, 0, -1, 1.5, 'x', true, [], {}])('rechaza roleId = %j', async (roleId) => {
        const plain: Record<string, unknown> = { roleId };
        if (roleId === undefined) delete plain.roleId;
        expect(await errorsOf(plain)).toEqual(['roleId']);
    });

    it('rechaza un body vacío (roleId es obligatorio, a diferencia de UpdateUserDto)', async () => {
        expect(await errorsOf({})).toEqual(['roleId']);
    });

    it('rechaza campos desconocidos: no admite otros campos de usuario', async () => {
        expect(await errorsOf({ roleId: 2, active: false })).toEqual(['active']);
    });
});
