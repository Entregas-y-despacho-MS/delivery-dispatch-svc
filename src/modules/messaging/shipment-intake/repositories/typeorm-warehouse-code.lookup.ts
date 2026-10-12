import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { Warehouse } from '../../../catalog/warehouses/entities/warehouse.entity.js';
import { WarehouseCodeLookup } from '../ports/warehouse-code.lookup.js';

@Injectable()
export class TypeOrmWarehouseCodeLookup extends WarehouseCodeLookup {
    constructor(@InjectRepository(Warehouse) private readonly rawRepo: Repository<Warehouse>) {
        super();
    }

    async exists(code: string, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(Warehouse) ?? this.rawRepo;
        return await repo.existsBy({ code });
    }
}
