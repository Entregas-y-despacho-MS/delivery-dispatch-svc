// ST-21.3 — pruebas unitarias de integridad de datos (RF-A29, Escenarios 2 y 3).
// Todo mockeado (repo de TypeORM) — sin DB, sin red. La validación de estimatedTimeMin positivo
// (Escenario 3) vive en el DTO (@IsInt/@IsPositive, cubierta por el ValidationPipe global, no acá).
import { describe, expect, it, vi } from 'vitest';
import { DeliveryZonesService } from './delivery-zones.service.js';
import { DeliveryZoneDto } from '../dto/delivery-zone.dto.js';
import { DeliveryZoneNotFoundException, DeliveryZoneCodeAlreadyExistsException } from '../exceptions/index.js';

function buildService() {
    const rawRepo = {
        create:     vi.fn((data: any = {}) => data),
        save:       vi.fn(async (entity: any) => ({ id: 1, createdAt: new Date(), ...entity })),
        update:     vi.fn(),
        delete:     vi.fn(),
        softDelete: vi.fn(),
        findOne:    vi.fn(),
    };
    const service = new DeliveryZonesService(rawRepo as any);
    return { service, rawRepo };
}

const EXISTING_ZONE = { id: 1, code: 'ZON-SUR', name: 'Zona Sur', estimatedTimeMin: 45, createdAt: new Date() };

describe('DeliveryZonesService — integridad de datos (RF-A29)', () => {
    describe('Escenario 2 — colisión de código de zona', () => {
        it('create() rechaza un código ya usado por otra zona', async () => {
            const { service, rawRepo } = buildService();
            rawRepo.findOne.mockResolvedValueOnce(EXISTING_ZONE); // existsByCode

            await expect(
                service.create(DeliveryZoneDto, { code: 'ZON-SUR', name: 'Otra Zona', estimatedTimeMin: 30 } as any),
            ).rejects.toThrow(DeliveryZoneCodeAlreadyExistsException);

            expect(rawRepo.save).not.toHaveBeenCalled();
        });

        it('create() acepta un código nuevo y persiste la zona', async () => {
            const { service, rawRepo } = buildService();
            rawRepo.findOne
                .mockResolvedValueOnce(null) // existsByCode — libre
                .mockResolvedValueOnce({ ...EXISTING_ZONE, id: 2, code: 'ZON-NORTE' }); // fetch final

            const result = await service.create(DeliveryZoneDto, { code: 'ZON-NORTE', name: 'Zona Norte', estimatedTimeMin: 30 } as any);

            expect(rawRepo.save).toHaveBeenCalled();
            expect((result as any).code).toBe('ZON-NORTE');
        });

        it('update() rechaza cambiar el código a uno que ya usa otra zona', async () => {
            const { service, rawRepo } = buildService();
            rawRepo.findOne
                .mockResolvedValueOnce({ ...EXISTING_ZONE, id: 2, code: 'ZON-NORTE' }) // findOneById (current)
                .mockResolvedValueOnce(EXISTING_ZONE); // existsByCode — 'ZON-SUR' ya pertenece a id 1

            await expect(
                service.update(DeliveryZoneDto, 2, { code: 'ZON-SUR' } as any),
            ).rejects.toThrow(DeliveryZoneCodeAlreadyExistsException);

            expect(rawRepo.update).not.toHaveBeenCalled();
        });

        it('update() permite reenviar el mismo código que ya tiene la propia zona (no es colisión)', async () => {
            const { service, rawRepo } = buildService();
            rawRepo.findOne
                .mockResolvedValueOnce(EXISTING_ZONE) // findOneById (current)
                .mockResolvedValueOnce({ ...EXISTING_ZONE, estimatedTimeMin: 60 }); // fetch final

            const result = await service.update(DeliveryZoneDto, 1, { code: 'ZON-SUR', estimatedTimeMin: 60 } as any);

            // No hubo una segunda consulta de existsByCode — solo current + fetch final.
            expect(rawRepo.findOne).toHaveBeenCalledTimes(2);
            expect(rawRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({ code: 'ZON-SUR', estimatedTimeMin: 60 }));
            expect((result as any).estimatedTimeMin).toBe(60);
        });

        it('update() de un campo distinto al código no dispara el chequeo de unicidad', async () => {
            const { service, rawRepo } = buildService();
            rawRepo.findOne
                .mockResolvedValueOnce(EXISTING_ZONE) // findOneById (current)
                .mockResolvedValueOnce({ ...EXISTING_ZONE, estimatedTimeMin: 90 }); // fetch final

            await service.update(DeliveryZoneDto, 1, { estimatedTimeMin: 90 } as any);

            expect(rawRepo.findOne).toHaveBeenCalledTimes(2);
        });
    });

    describe('remove()', () => {
        it('borra en soft-delete por default', async () => {
            const { service, rawRepo } = buildService();
            rawRepo.findOne.mockResolvedValueOnce(EXISTING_ZONE); // findOneById

            await service.remove(1);

            expect(rawRepo.softDelete).toHaveBeenCalledWith(1);
            expect(rawRepo.delete).not.toHaveBeenCalled();
        });

        it('borra en duro cuando se pide hardDelete', async () => {
            const { service, rawRepo } = buildService();
            rawRepo.findOne.mockResolvedValueOnce(EXISTING_ZONE); // findOneById

            await service.remove(1, { hardDelete: true });

            expect(rawRepo.delete).toHaveBeenCalledWith(1);
            expect(rawRepo.softDelete).not.toHaveBeenCalled();
        });

        it('lanza DeliveryZoneNotFoundException si la zona no existe', async () => {
            const { service, rawRepo } = buildService();
            rawRepo.findOne.mockResolvedValueOnce(null);

            await expect(service.remove(999)).rejects.toThrow(DeliveryZoneNotFoundException);
        });
    });
});
