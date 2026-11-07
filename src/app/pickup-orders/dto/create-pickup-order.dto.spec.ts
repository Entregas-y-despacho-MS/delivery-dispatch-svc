// ST-81.2 — validation of the body of POST /pickup-orders. No DB or network: class-validator directly, with the
// same options as the global ValidationPipe.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePickupOrderDto } from './create-pickup-order.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

const valid = {
    warehouseCode: 'WH-LPZ-01',
    contactName: 'María Fernández',
    contactPhone: '+591 71234567',
    address: 'Calle 21 de Calacoto 8790',
    latitude: -16.5421,
    longitude: -68.0802,
    preferredPickupDate: '2026-11-10',
    packageContents: '1 notebook',
    returnReason: 'Falla de encendido',
};

async function invalidProperties(plain: object): Promise<string[]> {
    return (await validate(plainToInstance(CreatePickupOrderDto, plain), OPTIONS)).map((e) => e.property);
}

describe('CreatePickupOrderDto', () => {
    it('accepts the required fields alone and with every optional one', async () => {
        expect(await invalidProperties(valid)).toEqual([]);
        expect(await invalidProperties({ ...valid, contactEmail: 'maria@example.com', reference: 'Segunda garita', estimatedBoxes: 2, rmaId: 'RMA-1' })).toEqual([]);
    });

    it.each(['warehouseCode', 'contactName', 'contactPhone', 'address', 'latitude', 'longitude', 'preferredPickupDate', 'packageContents', 'returnReason'])('%s is required', async (field) => {
        const { [field as keyof typeof valid]: _omitted, ...rest } = valid;
        expect(await invalidProperties(rest)).toEqual([field]);
    });

    it.each(['', '   '])('rejects a blank returnReason %j (the text is trimmed)', async (returnReason) => {
        expect(await invalidProperties({ ...valid, returnReason })).toEqual(['returnReason']);
    });

    it('rejects texts above their limit', async () => {
        expect(await invalidProperties({ ...valid, returnReason: 'x'.repeat(501) })).toEqual(['returnReason']);
        expect(await invalidProperties({ ...valid, packageContents: 'x'.repeat(501) })).toEqual(['packageContents']);
        expect(await invalidProperties({ ...valid, address: 'x'.repeat(301) })).toEqual(['address']);
    });

    it.each(['abc', '123', '++59171234567', '77a12345'])('rejects the phone %j', async (contactPhone) => {
        expect(await invalidProperties({ ...valid, contactPhone })).toEqual(['contactPhone']);
    });

    it.each([91, -91, 'north', null])('rejects latitude %j', async (latitude) => {
        expect(await invalidProperties({ ...valid, latitude })).toEqual(['latitude']);
    });

    it.each([181, -181, null])('rejects longitude %j', async (longitude) => {
        expect(await invalidProperties({ ...valid, longitude })).toEqual(['longitude']);
    });

    it.each(['2026-13-01', '2026-02-30', '10/11/2026', '2026-11-10T10:00:00Z', 20261110])('rejects preferredPickupDate %j', async (preferredPickupDate) => {
        expect(await invalidProperties({ ...valid, preferredPickupDate })).toEqual(['preferredPickupDate']);
    });

    it.each([0, -1, 1.5, 1001, '2'])('rejects estimatedBoxes %j', async (estimatedBoxes) => {
        expect(await invalidProperties({ ...valid, estimatedBoxes })).toEqual(['estimatedBoxes']);
    });

    it('rejects an invalid email and treats an empty optional text as not given', async () => {
        expect(await invalidProperties({ ...valid, contactEmail: 'not-an-email' })).toEqual(['contactEmail']);
        const dto = plainToInstance(CreatePickupOrderDto, { ...valid, contactEmail: '  ', reference: '', rmaId: ' ' });
        expect(await validate(dto, OPTIONS)).toEqual([]);
        expect([dto.contactEmail, dto.reference, dto.rmaId]).toEqual([null, null, null]);
    });

    it('rejects fields the form does not have, such as a time slot or a status', async () => {
        expect(await invalidProperties({ ...valid, windowStart: '2026-11-10T14:00:00Z', status: 'assigned' })).toEqual(['windowStart', 'status']);
    });
});
