// ST-23.3 — ServiceLevelsService: ordenamiento por prioridad, búsqueda/filtros, nombre único y la
// protección de borrado de niveles con despachos activos (RF-A31). Todo mockeado: sin DB ni red.
// (El orden y el borrado reales contra Postgres se cubren en test/service-levels.e2e-spec.ts.)
import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { ServiceLevelsService } from './service-levels.service.js';
import { ServiceLevelDto } from '../dto/service-level.dto.js';
import { FindAllServiceLevelsParamsDto } from '../dto/find-all-service-levels-params.dto.js';
import { ServiceLevel } from '../entities/service-level.entity.js';
import {
    ServiceLevelNotFoundException, ServiceLevelNameAlreadyExistsException, ServiceLevelInUseException,
} from '../exceptions/index.js';

const ROW = { id: 1, name: 'Express', description: null, targetTimeMin: 120, priorityLevel: 1, active: true, createdAt: new Date('2026-01-01T00:00:00Z') };

function buildService() {
    const rawRepo = {
        existsBy:     vi.fn().mockResolvedValue(false),
        create:       vi.fn(() => ({})),
        save:         vi.fn(async (entity: any) => ({ id: 1, ...entity })),
        update:       vi.fn(),
        softDelete:   vi.fn(),
        delete:       vi.fn(),
        findOne:      vi.fn().mockResolvedValue(ROW),
        findAndCount: vi.fn().mockResolvedValue([[], 0]),
    };
    const dispatchesService = { hasActiveByServiceLevel: vi.fn().mockResolvedValue(false) };
    const service = new ServiceLevelsService(rawRepo as any, dispatchesService as any);
    return { service, rawRepo, dispatchesService };
}

const duplicateError = () => new QueryFailedError('INSERT ...', [], Object.assign(new Error('dup'), { code: '23505' }));
const otherDbError   = () => new QueryFailedError('INSERT ...', [], Object.assign(new Error('null'), { code: '23502' }));
const op = (f: any) => ({ type: f.type, value: f.value });
const branches = (where: any) => (Array.isArray(where) ? where : [where]);

// ── listado y ordenamiento ─────────────────────────────────────────────────────
describe('ServiceLevelsService.findAll — ordenamiento y filtros (RF-A31)', () => {
    const run = async (over: object = {}) => {
        const { service, rawRepo } = buildService();
        const result = await service.findAll(ServiceLevelDto, plainToInstance(FindAllServiceLevelsParamsDto, over));
        return { options: rawRepo.findAndCount.mock.calls[0][0], result };
    };

    it('ordena por la jerarquía: prioridad (1 primero), luego tiempo objetivo, luego id', async () => {
        const { options } = await run();

        // El orden de las claves ES la precedencia del ORDER BY.
        expect(Object.keys(options.order)).toEqual(['priorityLevel', 'targetTimeMin', 'id']);
        expect(options.order).toEqual({ priorityLevel: 'ASC', targetTimeMin: 'ASC', id: 'ASC' });
    });

    it('el orden es el mismo con cualquier filtro, búsqueda o página', async () => {
        for (const over of [{ active: 'true' }, { search: 'express' }, { search: 'x', active: 'false', page: '3', limit: '5' }]) {
            const { options } = await run(over);
            expect(options.order, JSON.stringify(over)).toEqual({ priorityLevel: 'ASC', targetTimeMin: 'ASC', id: 'ASC' });
        }
    });

    it('sin filtros: todos los niveles, página 1 de 10', async () => {
        const { options } = await run();
        expect(options.where).toEqual({});
        expect(options).toMatchObject({ skip: 0, take: 10 });
    });

    it('pagina en el servidor y devuelve total y cantidad de páginas', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findAndCount.mockResolvedValue([[], 23]);

        const result = await service.findAll(ServiceLevelDto, plainToInstance(FindAllServiceLevelsParamsDto, { page: '3', limit: '10' }));

        expect(rawRepo.findAndCount.mock.calls[0][0]).toMatchObject({ skip: 20, take: 10 });
        expect(result.meta).toEqual({ page: 3, limit: 10, total: 23, pages: 3 });
    });

    it('active=true / false filtra por el estado habilitado', async () => {
        expect((await run({ active: 'true' })).options.where).toEqual({ active: true });
        expect((await run({ active: 'false' })).options.where).toEqual({ active: false });
    });

    it('un active vacío (?active=) no filtra: el DTO lo convierte en null y el servicio lo trata como "sin filtro"', async () => {
        expect((await run({ active: '' })).options.where).toEqual({});
    });

    it('search busca en nombre y en descripción, sin distinguir mayúsculas: 2 ramas OR', async () => {
        const { options } = await run({ search: 'Express' });
        const list = branches(options.where);

        expect(list).toHaveLength(2);
        expect(op(list[0].name)).toEqual({ type: 'ilike', value: '%Express%' });
        expect(op(list[1].description)).toEqual({ type: 'ilike', value: '%Express%' });
    });

    it('search escapa los comodines: "50%" y "a_b" se buscan literalmente', async () => {
        expect(op(branches((await run({ search: '50%' })).options.where)[0].name).value).toBe('%50\\%%');
        expect(op(branches((await run({ search: 'a_b' })).options.where)[0].name).value).toBe('%a\\_b%');
    });

    it('un search vacío o de solo espacios se ignora', async () => {
        expect((await run({ search: '' })).options.where).toEqual({});
        expect((await run({ search: '   ' })).options.where).toEqual({});
    });

    it('search + active: cada rama del OR conserva el filtro de estado (no se lo salta)', async () => {
        const { options } = await run({ search: 'express', active: 'false' });

        for (const branch of branches(options.where)) expect(branch.active).toBe(false);
        expect(branches(options.where)).toHaveLength(2);
    });
});

// ── alta ───────────────────────────────────────────────────────────────────────
describe('ServiceLevelsService.create', () => {
    const dto = { name: 'Express', description: 'Rápido', targetTimeMin: 120, priorityLevel: 1 };

    it('guarda el nivel habilitado (active = true) con los datos recibidos', async () => {
        const { service, rawRepo } = buildService();

        await service.create(ServiceLevelDto, dto as any);

        expect(rawRepo.save).toHaveBeenCalledTimes(1);
        expect(rawRepo.save.mock.calls[0][0]).toEqual({ name: 'Express', description: 'Rápido', targetTimeMin: 120, priorityLevel: 1, active: true });
    });

    it('devuelve el nivel ya persistido', async () => {
        const { service } = buildService();
        const result: any = await service.create(ServiceLevelDto, dto as any);
        expect(result).toMatchObject({ id: 1, name: 'Express', targetTimeMin: 120, priorityLevel: 1, active: true });
    });

    it('una descripción vacía u omitida se guarda como null', async () => {
        for (const description of ['', undefined]) {
            const { service, rawRepo } = buildService();
            await service.create(ServiceLevelDto, { ...dto, description } as any);
            expect(rawRepo.save.mock.calls[0][0].description, String(description)).toBeNull();
        }
    });

    it('un nombre que ya existe → 409 y no guarda nada', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(true);

        await expect(service.create(ServiceLevelDto, dto as any)).rejects.toThrow(ServiceLevelNameAlreadyExistsException);
        expect(rawRepo.existsBy).toHaveBeenCalledWith({ name: 'Express' });
        expect(rawRepo.save).not.toHaveBeenCalled();
    });

    it('si dos altas simultáneas pasan el pre-chequeo, el error del índice único se convierte en el mismo 409', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.save.mockRejectedValue(duplicateError());

        await expect(service.create(ServiceLevelDto, dto as any)).rejects.toThrow(ServiceLevelNameAlreadyExistsException);
    });

    it('cualquier otro error de la base se propaga tal cual (no se disfraza de 409)', async () => {
        const { service, rawRepo } = buildService();
        const failure = otherDbError();
        rawRepo.save.mockRejectedValue(failure);

        await expect(service.create(ServiceLevelDto, dto as any)).rejects.toBe(failure);
    });

    it('dentro de una transacción usa el repositorio del manager', async () => {
        const { service, rawRepo } = buildService();
        const txRepo = {
            existsBy: vi.fn().mockResolvedValue(false), create: vi.fn(() => ({})),
            save: vi.fn(async (e: any) => ({ id: 2, ...e })), findOne: vi.fn().mockResolvedValue(ROW),
        };
        const manager = { getRepository: vi.fn((entity: unknown) => (entity === ServiceLevel ? txRepo : null)) };

        await service.create(ServiceLevelDto, dto as any, { manager } as any);

        expect(txRepo.save).toHaveBeenCalledTimes(1);
        expect(rawRepo.save).not.toHaveBeenCalled();
    });
});

// ── edición ────────────────────────────────────────────────────────────────────
describe('ServiceLevelsService.update', () => {
    it('un nivel inexistente → ServiceLevelNotFoundException y no actualiza', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        await expect(service.update(ServiceLevelDto, 99, { active: false } as any)).rejects.toThrow(ServiceLevelNotFoundException);
        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('actualiza solo los campos enviados', async () => {
        const { service, rawRepo } = buildService();

        await service.update(ServiceLevelDto, 1, { targetTimeMin: 90 } as any);

        expect(rawRepo.update).toHaveBeenCalledWith(1, { targetTimeMin: 90 });
    });

    it('un PUT vacío no escribe nada (TypeORM lanza error con un update vacío) y devuelve el nivel', async () => {
        const { service, rawRepo } = buildService();

        const result: any = await service.update(ServiceLevelDto, 1, {} as any);

        expect(rawRepo.update).not.toHaveBeenCalled();
        expect(result.id).toBe(1);
    });

    it('desactivar: PUT active=false escribe solo ese campo', async () => {
        const { service, rawRepo } = buildService();
        await service.update(ServiceLevelDto, 1, { active: false } as any);
        expect(rawRepo.update).toHaveBeenCalledWith(1, { active: false });
    });

    it('descripción null o vacía la borra (queda null); un texto la reemplaza', async () => {
        for (const [input, expected] of [[null, null], ['', null], ['nueva', 'nueva']] as const) {
            const { service, rawRepo } = buildService();
            await service.update(ServiceLevelDto, 1, { description: input } as any);
            expect(rawRepo.update, String(input)).toHaveBeenCalledWith(1, { description: expected });
        }
    });

    it('renombrar a un nombre de OTRO nivel → 409 y no escribe', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(true);

        await expect(service.update(ServiceLevelDto, 1, { name: 'Standard' } as any)).rejects.toThrow(ServiceLevelNameAlreadyExistsException);
        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('reenviar el nombre que ya tiene el propio nivel no cuenta como colisión (ni consulta)', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(true); // si se consultara, daría 409

        await service.update(ServiceLevelDto, 1, { name: 'Express', targetTimeMin: 60 } as any);

        expect(rawRepo.existsBy).not.toHaveBeenCalled();
        expect(rawRepo.update).toHaveBeenCalledWith(1, { name: 'Express', targetTimeMin: 60 });
    });

    it('el error del índice único al actualizar también es 409; otros errores se propagan', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.update.mockRejectedValueOnce(duplicateError());
        await expect(service.update(ServiceLevelDto, 1, { name: 'X' } as any)).rejects.toThrow(ServiceLevelNameAlreadyExistsException);

        const failure = otherDbError();
        rawRepo.update.mockRejectedValueOnce(failure);
        await expect(service.update(ServiceLevelDto, 1, { name: 'Y' } as any)).rejects.toBe(failure);
    });
});

// ── borrado ────────────────────────────────────────────────────────────────────
describe('ServiceLevelsService.remove — protección de niveles con despachos activos (RF-A31, Escenario 3)', () => {
    it('con despachos activos → ServiceLevelInUseException y NO borra', async () => {
        const { service, rawRepo, dispatchesService } = buildService();
        dispatchesService.hasActiveByServiceLevel.mockResolvedValue(true);

        await expect(service.remove(1)).rejects.toThrow(ServiceLevelInUseException);

        expect(rawRepo.softDelete).not.toHaveBeenCalled();
        expect(rawRepo.delete).not.toHaveBeenCalled();
    });

    it('el error de "en uso" explica la salida: desactivarlo con active: false', async () => {
        const { service, dispatchesService } = buildService();
        dispatchesService.hasActiveByServiceLevel.mockResolvedValue(true);

        const error: any = await service.remove(1).catch((e) => e);

        expect(error.getStatus()).toBe(409);
        expect(error.getResponse()).toMatchObject({ error: 'SERVICE_LEVEL_IN_USE' });
        expect(error.getResponse().message).toContain('active: false');
    });

    it('sin despachos activos → baja lógica (soft delete)', async () => {
        const { service, rawRepo } = buildService();

        await service.remove(1);

        expect(rawRepo.softDelete).toHaveBeenCalledWith(1);
        expect(rawRepo.delete).not.toHaveBeenCalled();
    });

    it('con hardDelete borra en duro (solo si se pide explícitamente)', async () => {
        const { service, rawRepo } = buildService();

        await service.remove(1, { hardDelete: true });

        expect(rawRepo.delete).toHaveBeenCalledWith(1);
        expect(rawRepo.softDelete).not.toHaveBeenCalled();
    });

    it('un nivel inexistente → ServiceLevelNotFoundException, sin siquiera consultar los despachos', async () => {
        const { service, rawRepo, dispatchesService } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        await expect(service.remove(99)).rejects.toThrow(ServiceLevelNotFoundException);

        expect(dispatchesService.hasActiveByServiceLevel).not.toHaveBeenCalled();
        expect(rawRepo.softDelete).not.toHaveBeenCalled();
    });

    it('consulta los despachos del nivel correcto, pasando las opciones (transacción)', async () => {
        const { service, dispatchesService } = buildService();
        const txRepo = { softDelete: vi.fn() };
        const manager = { getRepository: vi.fn().mockReturnValue(txRepo) };
        const options = { manager } as any;

        await service.remove(7, options);

        expect(dispatchesService.hasActiveByServiceLevel).toHaveBeenCalledWith(7, options);
        expect(txRepo.softDelete).toHaveBeenCalledWith(7);
    });
});

describe('ServiceLevelsService.findOneById', () => {
    it('con throwException: false devuelve null si no existe', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        expect(await service.findOneById(ServiceLevelDto, 5, { throwException: false })).toBeNull();
        await expect(service.findOneById(ServiceLevelDto, 5)).rejects.toThrow(ServiceLevelNotFoundException);
    });
});
