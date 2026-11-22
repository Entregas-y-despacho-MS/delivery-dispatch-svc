import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderDispatchEventEntity } from './entities/order-dispatch-event.entity.js';
import { OrderDispatchEventsService } from './services/order-dispatch-events.service.js';

/** Business history of orders and dispatches (RF-A36, ST-69). @Global(): every transition writes through it. */
@Global()
@Module({
    imports: [TypeOrmModule.forFeature([OrderDispatchEventEntity])],
    providers: [OrderDispatchEventsService],
    exports: [OrderDispatchEventsService],
})
export class OrderDispatchEventsModule {}
