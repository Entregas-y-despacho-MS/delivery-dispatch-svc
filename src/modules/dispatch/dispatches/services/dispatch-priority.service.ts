import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Dispatch } from '../entities/dispatch.entity.js';
import { DispatchEvent } from '../../dispatch-events/entities/dispatch-event.entity.js';
import { DispatchNotFoundException, DispatchPriorityNotChangeableException } from '../exceptions/index.js';
import { DispatchPriorityDto } from '../dto/dispatch-priority.dto.js';
import { DispatchPriority } from '../dto/update-dispatch-priority.dto.js';
import { DispatchStatusEnum } from '../../../../shared/enums/index.js';

// RF-A11 / ST-58.2: the priority can still be changed while the order has not been handed to a route.
export const PRIORITY_CHANGEABLE_STATUSES: string[] = [DispatchStatusEnum.PENDING, DispatchStatusEnum.IN_PLANNING, DispatchStatusEnum.SCHEDULED];

export const PRIORITY_CHANGED_EVENT = 'priority_changed';

@Injectable()
export class DispatchPriorityService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**
     * Manual priority change (RF-A11). Only the `priority` column is written: `urgent` orders the queue of
     * free capacity, it never touches the deadline, the window or an approved promise (D-15). The row is
     * locked for the transaction so the status check and the write see the same dispatch. Asking for the
     * value it already has is a no-op (no write, no event).
     */
    async changePriority(dispatchId: number, priority: DispatchPriority, actorUserId: number): Promise<DispatchPriorityDto> {
        return await this.dataSource.transaction(async (manager) => {
            const [row]: { priority: string; status: string }[] = await manager.query(
                `SELECT d.priority, s.name AS status
                   FROM dispatches d
                   JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
                  WHERE d.dispatch_id = $1
                    FOR UPDATE OF d`,
                [dispatchId],
            );
            if (!row) throw new DispatchNotFoundException();

            const { status } = row;
            if (!PRIORITY_CHANGEABLE_STATUSES.includes(status)) throw new DispatchPriorityNotChangeableException(status);
            if (row.priority === priority) return { id: dispatchId, priority, status };

            await manager.getRepository(Dispatch).update(dispatchId, { priority });
            const events = manager.getRepository(DispatchEvent);
            await events.save(events.create({
                dispatchId,
                eventType: PRIORITY_CHANGED_EVENT,
                detail:    `Priority changed from ${row.priority} to ${priority}.`,
                actorUserId,
                actorType: 'user',
                metadata:  { from: row.priority, to: priority },
            }));
            return { id: dispatchId, priority, status };
        });
    }
}
