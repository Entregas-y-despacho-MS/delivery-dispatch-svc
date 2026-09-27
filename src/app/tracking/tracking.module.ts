import { Module } from '@nestjs/common';
import { TrackingController } from './controllers/tracking.controller.js';
import { TrackingService } from './services/tracking.service.js';
import { DispatchesModule } from '../../modules/dispatch/dispatches/dispatches.module.js';

// No own table — orchestrates DispatchesService (last known position) and SocketService (the
// 'dispatch-board' live room) for RF-U11. Same shape as app/sync: "system logic", not a domain CRUD
// module. SocketService/EventEmitter2 are both global (SocketModule, EventEmitterModule.forRoot() in
// AppModule) — nothing to import for either here.
@Module({
    imports:     [DispatchesModule],
    controllers: [TrackingController],
    providers:   [TrackingService],
})
export class TrackingModule {}
