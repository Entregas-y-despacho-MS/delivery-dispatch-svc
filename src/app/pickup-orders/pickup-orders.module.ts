import { Module } from '@nestjs/common';
import { RmaPickupIntakeModule } from '../../modules/messaging/rma-pickup-intake/rma-pickup-intake.module.js';
import { PickupOrdersController } from './pickup-orders.controller.js';
import { PickupOrdersService } from './pickup-orders.service.js';

/** ST-81.2 (ES-81, RF-A39): customer pickup orders registered, cancelled and listed from the web. */
@Module({
    imports:     [RmaPickupIntakeModule],
    controllers: [PickupOrdersController],
    providers:   [PickupOrdersService],
})
export class PickupOrdersModule {}
