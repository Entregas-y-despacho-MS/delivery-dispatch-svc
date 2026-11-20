import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAuditEventEntity } from './entities/admin-audit-event.entity.js';
import { AdminAuditInterceptor } from './interceptors/admin-audit.interceptor.js';
import { correlationIdMiddleware } from './middleware/correlation-id.middleware.js';
import { AdminAuditService } from './services/admin-audit.service.js';

/**
 * Audit trail of the sensitive administrative actions (RF-A35). @Global(): the auth guards record the
 * denials through `AdminAuditService`. Querying and exporting the trail (RF-A37, RF-A38) is not part of it yet.
 */
@Global()
@Module({
    imports: [TypeOrmModule.forFeature([AdminAuditEventEntity])],
    providers: [AdminAuditService, { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor }],
    exports: [AdminAuditService],
})
export class AdminAuditEventsModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(correlationIdMiddleware).forRoutes('*');
    }
}
