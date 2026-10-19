import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../dispatch-status/dispatch-status-changed.event.js';
import { DispatchOtpService } from './dispatch-otp.service.js';

@Injectable()
export class DispatchOtpListener {
    private readonly logger = new Logger(DispatchOtpListener.name);
    constructor(private readonly otp: DispatchOtpService) {}

    @OnEvent(DISPATCH_STATUS_CHANGED_EVENT, { async: true })
    async handle(event: DispatchStatusChangedEvent): Promise<void> {
        if (event.status !== 'in_transit') return;
        try { await this.otp.onInTransit(event.dispatchId); }
        catch {
            this.logger.error({ event: 'otp_processing_failed', dispatchId: event.dispatchId });
            try { await this.otp.markProcessingFailure(event.dispatchId); }
            catch { this.logger.error({ event: 'otp_resolution_record_failed', dispatchId: event.dispatchId }); }
        }
    }
}
