import { Module } from '@nestjs/common';
import { DeliveryEvidencesModule } from '../../modules/dispatch/delivery-evidences/delivery-evidences.module.js';
import { DispatchesModule } from '../../modules/dispatch/dispatches/dispatches.module.js';
import { DispatchOtpModule } from '../dispatch-otp/dispatch-otp.module.js';
import { DispatchEvidenceController } from './dispatch-evidence.controller.js';
import { DispatchEvidenceSocketListener } from './dispatch-evidence.socket-listener.js';
import { DispatchEvidenceService } from './dispatch-evidence.service.js';

// No own table: registers delivery evidences (ST-31.3) on top of delivery-evidences and dispatches.
@Module({
    imports:     [DeliveryEvidencesModule, DispatchesModule, DispatchOtpModule],
    controllers: [DispatchEvidenceController],
    providers:   [DispatchEvidenceService, DispatchEvidenceSocketListener],
    exports:     [DispatchEvidenceService],
})
export class DispatchEvidenceModule {}
