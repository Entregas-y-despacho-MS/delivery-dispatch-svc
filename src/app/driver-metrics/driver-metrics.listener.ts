import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DispatchStatusEnum } from '../../shared/enums/dispatch-status.enum.js';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../dispatch-status/dispatch-status-changed.event.js';
import { DriverMetricsRepository } from './repositories/driver-metrics.repository.js';
import { DriverMetricsService } from './services/driver-metrics.service.js';

/**
 * A confirmed delivery changes the driver's figures, so the cached metrics are dropped. Every writer of a
 * status (the driver's PATCH, the offline sync, the batch jobs) emits this event after its transaction
 * commits, so a single listener covers all of them. It never fails the delivery: the event is async and a
 * failure here is only logged (the entries expire within 5 minutes anyway).
 */
@Injectable()
export class DriverMetricsListener {
    private readonly logger = new Logger(DriverMetricsListener.name);

    constructor(
        private readonly repository: DriverMetricsRepository,
        private readonly metrics: DriverMetricsService,
    ) {}

    @OnEvent(DISPATCH_STATUS_CHANGED_EVENT, { async: true })
    async handle(event: DispatchStatusChangedEvent): Promise<void> {
        if (event.status !== DispatchStatusEnum.DELIVERED) return;
        try {
            const driverId = await this.repository.findDriverIdOfDispatch(event.dispatchId);
            if (driverId !== null) await this.metrics.invalidate(driverId);
        } catch (error) {
            this.logger.warn(`Could not invalidate the driver metrics of dispatch ${event.dispatchId}. ${error instanceof Error ? error.message : ''}`.trim());
        }
    }
}
