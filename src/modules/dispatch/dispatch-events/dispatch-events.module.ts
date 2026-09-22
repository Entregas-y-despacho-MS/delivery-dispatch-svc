import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DispatchEvent } from './entities/dispatch-event.entity.js';
import { DispatchEventsService } from './services/dispatch-events.service.js';

@Module({
    imports:   [TypeOrmModule.forFeature([DispatchEvent])],
    providers: [DispatchEventsService],
    exports:   [DispatchEventsService],
})
export class DispatchEventsModule {}
