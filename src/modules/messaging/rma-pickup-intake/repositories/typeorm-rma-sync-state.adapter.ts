import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { RmaSyncState as RmaSyncStateEntity } from '../entities/rma-sync-state.entity.js';
import { RmaSyncStatePort, type RmaSyncState } from '../ports/rma-sync-state.port.js';

/** Migration 021 adapter. */
@Injectable()
export class TypeOrmRmaSyncStateAdapter extends RmaSyncStatePort {
    constructor(
        @InjectRepository(RmaSyncStateEntity) private readonly rawRepo: Repository<RmaSyncStateEntity>,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {
        super();
    }

    async find(rmaId: string, options?: MutationOptions): Promise<RmaSyncState | null> {
        const repo = options?.manager?.getRepository(RmaSyncStateEntity) ?? this.rawRepo;
        const row = await repo.findOneBy({ rmaId });
        return row ? { rmaId: row.rmaId, lastRecordVersion: Number(row.lastRecordVersion) } : null;
    }

    async save(state: RmaSyncState, options?: MutationOptions): Promise<void> {
        const sql = `INSERT INTO rma_sync_states (rma_id, last_record_version)
                     VALUES ($1, $2)
                     ON CONFLICT (rma_id) DO UPDATE SET
                         last_record_version = EXCLUDED.last_record_version,
                         updated_at = NOW()
                     WHERE rma_sync_states.last_record_version <= EXCLUDED.last_record_version`;
        const values = [state.rmaId, String(state.lastRecordVersion)];
        if (options?.manager) await options.manager.query(sql, values);
        else await this.dataSource.query(sql, values);
    }
}
