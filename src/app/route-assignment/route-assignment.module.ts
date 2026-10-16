import { Module } from '@nestjs/common';
import { RouteAssignedSocketListener } from './route-assigned-socket.listener.js';

@Module({ providers: [RouteAssignedSocketListener] })
export class RouteAssignmentModule {}
