import { Module } from '@nestjs/common';
import { PushTokensModule } from '../../modules/auth/push-tokens/push-tokens.module.js';
import { PushReceiptMonitor } from './push-receipt-monitor.js';
import { RouteAssignedPushListener } from './route-assigned-push.listener.js';
import { RouteAssignedSocketListener } from './route-assigned-socket.listener.js';
import { RoutePushNotificationService } from './route-push-notification.service.js';

@Module({
  imports: [PushTokensModule],
  providers: [RouteAssignedSocketListener, RouteAssignedPushListener, RoutePushNotificationService, PushReceiptMonitor],
})
export class RouteAssignmentModule {}
