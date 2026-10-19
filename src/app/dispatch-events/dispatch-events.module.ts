import { Module } from '@nestjs/common';
import { DispatchEventsSocketListener } from './dispatch-events.socket-listener.js';

@Module({ providers: [DispatchEventsSocketListener] })
export class DispatchEventsAppModule {}
