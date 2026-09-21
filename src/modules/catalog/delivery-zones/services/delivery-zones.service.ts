import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { DeliveryZone } from '../entities/delivery-zone.entity.js';
import { DeliveryZoneDto } from '../dto/delivery-zone.dto.js';
import { CreateDeliveryZoneDto } from '../dto/create-delivery-zone.dto.js';
import { UpdateDeliveryZoneDto } from '../dto/update-delivery-zone.dto.js';
import { FindAllDeliveryZonesParamsDto } from '../dto/find-all-delivery-zones-params.dto.js';
import { DeliveryZoneNotFoundException, DeliveryZoneCodeAlreadyExistsException } from '../exceptions/index.js';
import { DtoRepository } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions, MutationOptions } from '../../../../shared/dto/options.dto.js';

@Injectable()
export class DeliveryZonesService {
    private readonly repo: DtoRepository<DeliveryZone>;

    constructor(
        @InjectRepository(DeliveryZone)
        private readonly rawRepo: Repository<DeliveryZone>,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    async findAll<T>(dto: new () => T, params: FindAllDeliveryZonesParamsDto): Promise<PaginationResponseDto<T>> {
        return this.repo.findPaginated({
            dto,
            pagination: params,
            where: params.search
                ? [{ code: ILike(`%${params.search}%`) }, { name: ILike(`%${params.search}%`) }]
                : {},
            order: { name: 'ASC' },
        });
    }

    findOne<T>(dto: new () => T, where: FindOptionsWhere<DeliveryZone>, options: { throwException: false }): Promise<T | null>;
    findOne<T>(dto: new () => T, where: FindOptionsWhere<DeliveryZone>, options?: FindOptions): Promise<T>;
    async findOne<T>(dto: new () => T, where: FindOptionsWhere<DeliveryZone>, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, where, throwException);
    }

    findOneById<T>(dto: new () => T, id: number, options: { throwException: false }): Promise<T | null>;
    findOneById<T>(dto: new () => T, id: number, options?: FindOptions): Promise<T>;
    async findOneById<T>(dto: new () => T, id: number, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { id }, throwException);
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    async create<T>(returnDto: new () => T, dto: CreateDeliveryZoneDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(DeliveryZone) ?? this.rawRepo;

        // RF-A29, Escenario 2 — control de colisión de código de zona.
        if (await this.existsByCode(dto.code)) throw new DeliveryZoneCodeAlreadyExistsException();

        const zone            = repo.create();
        zone.code              = dto.code;
        zone.name              = dto.name;
        zone.estimatedTimeMin  = dto.estimatedTimeMin;

        const saved = await repo.save(zone);

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id: saved.id } });
        return result!;
    }

    async update<T>(returnDto: new () => T, id: number, dto: UpdateDeliveryZoneDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(DeliveryZone) ?? this.rawRepo;

        const current = await this.findOneById(DeliveryZoneDto, id);

        if (dto.code !== undefined && dto.code !== current.code) {
            if (await this.existsByCode(dto.code, id)) throw new DeliveryZoneCodeAlreadyExistsException();
        }

        const payload: Record<string, any> = {};
        if (dto.code             !== undefined) payload.code             = dto.code;
        if (dto.name             !== undefined) payload.name             = dto.name;
        if (dto.estimatedTimeMin !== undefined) payload.estimatedTimeMin = dto.estimatedTimeMin;

        await repo.update(id, payload);

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id } });
        return result!;
    }

    async remove(id: number, options?: MutationOptions): Promise<void> {
        const repo = options?.manager?.getRepository(DeliveryZone) ?? this.rawRepo;
        await this.findOneById(DeliveryZoneDto, id);
        if (options?.hardDelete) {
            await repo.delete(id);
        } else {
            await repo.softDelete(id);
        }
    }

    // ── Private implementation ────────────────────────────────────────────────

    private async existsByCode(code: string, excludeId?: number): Promise<boolean> {
        const found = await this.rawRepo.findOne({ where: { code } });
        return !!found && found.id !== excludeId;
    }

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<DeliveryZone>, throwException: boolean): Promise<T | null> {
        const result = await this.repo.findOne({ dto, where });
        if (!result && throwException) throw new DeliveryZoneNotFoundException();
        return result;
    }
}
