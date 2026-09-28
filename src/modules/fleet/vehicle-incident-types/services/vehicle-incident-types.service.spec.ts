// RF-A34 — VehicleIncidentTypesService: filtros/orden del listado, unicidad de código/nombre,
// actualización parcial, y getDisablesVehicle (lo que consume el trigger de VehicleMaintenancesService).
// Todo mockeado: sin DB ni red.
import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { VehicleIncidentTypesService } from './vehicle-incident-types.service.js';
import { VehicleIncidentTypeDto } from '../dto/vehicle-incident-type.dto.js';
import { FindAllVehicleIncidentTypesParamsDto } from '../dto/find-all-vehicle-incident-types-params.dto.js';
import { VehicleIncidentTypeNotFoundException, VehicleIncidentTypeCodeAlreadyExistsException } from '../exceptions/index.js';
import { VehicleIncidentSeverityEnum } from '../../../../shared/enums/index.js';

const ROW = { id: 1, code: 'MEC-FRE-01', name: 'Falla en sistema de frenos', severity: 'critical', disablesVehicle: true, createdAt: new Date('2026-01-01T00:00:00Z') };

function buildService() {
    const rawRepo = {
        existsBy:     vi.fn().mockResolvedValue(false),
        create:       vi.fn(() => ({})),
        save:         vi.fn(async (entity: any) => ({ id: 1, ...entity })),
        update:       vi.fn(),
        findOne:      vi.fn().mockResolvedValue(ROW),
        findAndCount: vi.fn().mockResolvedValue([[], 0]),
    };
    const service = new VehicleIncidentTypesService(rawRepo as any);
    return { service, rawRepo };
}

const duplicateError = () => new QueryFailedError('INSERT ...', [], Object.assign(new Error('dup'), { code: '23505' }));
const branches = (where: any) => (Array.isArray(where) ? where : [where]);
const op = (f: any) => ({ type: f.type, value: f.value });
const validCreate = (over: object = {}) => ({ code: 'MEC-X', name: 'X', severity: VehicleIncidentSeverityEnum.CRITICAL, disablesVehicle: true, ...over });

// ── listado, orden y filtros ───────────────────────────────────────────────────
describe('VehicleIncidentTypesService.findAll — orden y filtros', () => {
    const run = async (over: object = {}) => {
        const { service, rawRepo } = buildService();
        const result = await service.findAll(VehicleIncidentTypeDto, plainToInstance(FindAllVehicleIncidentTypesParamsDto, over));
        return { options: rawRepo.findAndCount.mock.calls[0][0], result };
    };

    it('ordena por nombre por defecto, desempatando por id', async () => {
        expect((await run()).options.order).toEqual({ name: 'ASC', id: 'ASC' });
    });

    it('sortBy/sortOrder cambian el campo y la dirección, siempre con id ASC al final', async () => {
        expect((await run({ sortBy: 'code' })).options.order).toEqual({ code: 'ASC', id: 'ASC' });
        expect((await run({ sortBy: 'severity', sortOrder: 'desc' })).options.order).toEqual({ severity: 'DESC', id: 'ASC' });
    });

    it('sin filtros, el where es {}', async () => {
        expect((await run()).options.where).toEqual({});
    });

    it('severity y disablesVehicle filtran; un disablesVehicle vacío (convertido a null por el DTO) no filtra', async () => {
        expect((await run({ severity: 'critical' })).options.where).toEqual({ severity: 'critical' });
        expect((await run({ disablesVehicle: 'true' })).options.where).toEqual({ disablesVehicle: true });
        expect((await run({ disablesVehicle: '' })).options.where).toEqual({});
        expect((await run({ disablesVehicle: '', severity: 'minor' })).options.where).toEqual({ severity: 'minor' });
    });

    it('search busca en código o nombre (2 ramas del OR) con ILIKE contiene, sin distinguir mayúsculas', async () => {
        const list = branches((await run({ search: 'freno' })).options.where);
        expect(list).toHaveLength(2);
        expect(op(list[0].code)).toEqual({ type: 'ilike', value: '%freno%' });
        expect(op(list[1].name)).toEqual({ type: 'ilike', value: '%freno%' });
    });

    it('search + severity + disablesVehicle: cada rama del OR conserva ambos filtros', async () => {
        const list = branches((await run({ search: 'x', disablesVehicle: 'false', severity: 'moderate' })).options.where);
        for (const branch of list) expect(branch).toMatchObject({ disablesVehicle: false, severity: 'moderate' });
    });

    it('pagination: skip/take y meta', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findAndCount.mockResolvedValue([[ROW], 1]);

        const result = await service.findAll(VehicleIncidentTypeDto, plainToInstance(FindAllVehicleIncidentTypesParamsDto, { page: '2', limit: '5' }));

        expect(rawRepo.findAndCount.mock.calls[0][0]).toMatchObject({ skip: 5, take: 5 });
        expect(result.meta).toEqual({ page: 2, limit: 5, total: 1, pages: 1 });
    });
});

// ── alta ──────────────────────────────────────────────────────────────────────
describe('VehicleIncidentTypesService.create', () => {
    it('guarda code/name/severity/disablesVehicle tal cual, con manager cuando se pasa uno', async () => {
        const { service, rawRepo } = buildService();
        const managerRepo = { existsBy: vi.fn().mockResolvedValue(false), create: vi.fn(() => ({})), save: vi.fn(async (e: any) => ({ id: 9, ...e })), findOne: vi.fn().mockResolvedValue(ROW) };
        const manager = { getRepository: vi.fn(() => managerRepo) };

        await service.create(VehicleIncidentTypeDto, validCreate({ disablesVehicle: false }), { manager } as any);

        expect(managerRepo.save).toHaveBeenCalledWith(expect.objectContaining({ code: 'MEC-X', name: 'X', severity: VehicleIncidentSeverityEnum.CRITICAL, disablesVehicle: false }));
        expect(rawRepo.save).not.toHaveBeenCalled();
    });

    it('nombre repetido (chequeo previo) → 409, sin llegar a guardar', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockImplementation(async ({ name }: any) => name === ROW.name);

        await expect(service.create(VehicleIncidentTypeDto, validCreate({ code: 'MEC-NEW', name: ROW.name })))
            .rejects.toThrow(VehicleIncidentTypeCodeAlreadyExistsException);
        expect(rawRepo.save).not.toHaveBeenCalled();
    });

    it('código repetido (chequeo previo) → 409, sin llegar a guardar ni a chequear el nombre', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(true);

        await expect(service.create(VehicleIncidentTypeDto, validCreate({ code: ROW.code })))
            .rejects.toThrow(VehicleIncidentTypeCodeAlreadyExistsException);
        expect(rawRepo.existsBy).toHaveBeenCalledTimes(1);
        expect(rawRepo.save).not.toHaveBeenCalled();
    });

    it('nombre o código repetido (carrera — el índice único de la base) → el mismo 409, no un 500', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.save.mockRejectedValue(duplicateError());

        await expect(service.create(VehicleIncidentTypeDto, validCreate())).rejects.toThrow(VehicleIncidentTypeCodeAlreadyExistsException);
    });
});

// ── edición ───────────────────────────────────────────────────────────────────
describe('VehicleIncidentTypesService.update', () => {
    it('solo cambia los campos enviados', async () => {
        const { service, rawRepo } = buildService();

        await service.update(VehicleIncidentTypeDto, 1, { severity: VehicleIncidentSeverityEnum.MINOR });

        expect(rawRepo.update).toHaveBeenCalledWith(1, { severity: VehicleIncidentSeverityEnum.MINOR });
    });

    it('un PUT vacío no escribe nada', async () => {
        const { service, rawRepo } = buildService();

        await service.update(VehicleIncidentTypeDto, 1, {});

        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('cambiar disablesVehicle es una actualización normal', async () => {
        const { service, rawRepo } = buildService();

        await service.update(VehicleIncidentTypeDto, 1, { disablesVehicle: false });

        expect(rawRepo.update).toHaveBeenCalledWith(1, { disablesVehicle: false });
    });

    it('tipo inexistente → 404, sin intentar escribir', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        await expect(service.update(VehicleIncidentTypeDto, 999, { disablesVehicle: false })).rejects.toThrow(VehicleIncidentTypeNotFoundException);
        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('el índice único (carrera) también da 409 en vez de 500', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.update.mockRejectedValue(duplicateError());

        await expect(service.update(VehicleIncidentTypeDto, 1, { name: 'Racy' })).rejects.toThrow(VehicleIncidentTypeCodeAlreadyExistsException);
    });
});

// ── getDisablesVehicle (lo que consume VehicleMaintenancesService) ────────────
describe('VehicleIncidentTypesService.getDisablesVehicle', () => {
    it('devuelve el flag del tipo cuando existe', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue({ id: 1, disablesVehicle: true });

        expect(await service.getDisablesVehicle(1)).toBe(true);
    });

    it('devuelve false tal cual cuando el flag es false (no lo confunde con "no encontrado")', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue({ id: 1, disablesVehicle: false });

        expect(await service.getDisablesVehicle(1)).toBe(false);
    });

    it('devuelve null cuando el tipo no existe', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        expect(await service.getDisablesVehicle(999)).toBeNull();
    });

    it('dentro de una transacción usa el repositorio del manager, no el global', async () => {
        const { service, rawRepo } = buildService();
        const txRepo = { findOne: vi.fn().mockResolvedValue({ id: 1, disablesVehicle: true }) };
        const manager = { getRepository: vi.fn().mockReturnValue(txRepo) };

        expect(await service.getDisablesVehicle(1, { manager } as any)).toBe(true);

        expect(txRepo.findOne).toHaveBeenCalledTimes(1);
        expect(rawRepo.findOne).not.toHaveBeenCalled();
    });
});
