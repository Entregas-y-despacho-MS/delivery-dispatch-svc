import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { NoNullBytesPipe } from './shared/pipes/index.js';
import { AppConfigModule } from './config/config.module.js';
import { HealthModule } from './app/health/health.module.js';
import { DatabaseModule } from './database/database.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { UsersModule } from './modules/auth/users/users.module.js';
import { RolesModule } from './modules/auth/roles/roles.module.js';
import { DeliveryZonesModule } from './modules/catalog/delivery-zones/delivery-zones.module.js';
import { VehiclesModule } from './modules/fleet/vehicles/vehicles.module.js';
import { ServiceLevelsModule } from './modules/catalog/service-levels/service-levels.module.js';
import { IncidentReasonsModule } from './modules/catalog/incident-reasons/incident-reasons.module.js';
import { RescheduleReasonsModule } from './modules/catalog/reschedule-reasons/reschedule-reasons.module.js';
import { WarehousesModule } from './modules/catalog/warehouses/warehouses.module.js';
import { VehicleIncidentTypesModule } from './modules/fleet/vehicle-incident-types/vehicle-incident-types.module.js';
import { VehicleMaintenancesModule } from './modules/fleet/vehicle-maintenances/vehicle-maintenances.module.js';
import { AuthModule } from './app/auth/auth.module.js';
import { SyncModule } from './app/sync/sync.module.js';
import { TrackingModule } from './app/tracking/tracking.module.js';
import { MailerModule } from './plugins/mailer/mailer.module.js';
import { SocketModule } from './plugins/socket/socket.module.js';
import { PdfModule } from './plugins/pdf/pdf.module.js';
import { StorageModule } from './plugins/storage/storage.module.js';
import { PushModule } from './plugins/push/push.module.js';
import { OsrmModule } from './plugins/osrm/osrm.module.js';
import { PendingOrdersModule } from './modules/dispatch/pending-orders/pending-orders.module.js';
import { PickupSchedulingModule } from './modules/dispatch/pickup-scheduling/pickup-scheduling.module.js';
import { RouteBatchesModule } from './modules/dispatch/route-batches/route-batches.module.js';
import { DispatchReservationsModule } from './modules/dispatch/dispatch-reservations/dispatch-reservations.module.js';
import { CacheModule } from './plugins/cache/cache.module.js';
import { MessagingModule } from './plugins/messaging/messaging.module.js';
import { InboundMessagesModule } from './modules/messaging/inbound-messages/inbound-messages.module.js';
import { OutboundMessagesModule } from './modules/messaging/outbound-messages/outbound-messages.module.js';
import { SalesOrderIntakeModule } from './modules/messaging/sales-order-intake/sales-order-intake.module.js';
import { IncompleteOrderRecoveryModule } from './modules/messaging/incomplete-order-recovery/incomplete-order-recovery.module.js';
import { SchedulerModule } from './app/scheduler/scheduler.module.js';
import { PlanningModule } from './app/planning/planning.module.js';
import { PromiseFirmingModule } from './app/promise-firming/promise-firming.module.js';
import { RouteCutoffModule } from './app/route-cutoff/route-cutoff.module.js';

@Module({
  imports: [
    // Global, registered once here — see plugins/socket/socket.module.ts for why it isn't
    // re-registered there too. Used to decouple the socket plugin (generic transport) from the
    // business modules that react to a connection (e.g. app/tracking's 'dispatch-board' room).
    EventEmitterModule.forRoot(),
    AppConfigModule,
    CacheModule.register(),
    MessagingModule.register(),
    InboundMessagesModule,
    OutboundMessagesModule,
    SalesOrderIntakeModule,
    IncompleteOrderRecoveryModule,
    HealthModule,
    DatabaseModule,
    SettingsModule,
    SchedulerModule,
    PlanningModule,
    PromiseFirmingModule,
    RouteCutoffModule,
    UsersModule,
    RolesModule,
    DeliveryZonesModule,
    VehiclesModule,
    ServiceLevelsModule,
    IncidentReasonsModule,
    RescheduleReasonsModule,
    WarehousesModule,
    VehicleIncidentTypesModule,
    VehicleMaintenancesModule,
    AuthModule,
    SyncModule,
    TrackingModule,
    MailerModule.register(),
    SocketModule,
    PdfModule,
    StorageModule.register(),
    PushModule.register(),
    OsrmModule,
    PendingOrdersModule,
    RouteBatchesModule,
    DispatchReservationsModule,
    PickupSchedulingModule,
  ],
  providers: [
    // Rejects NUL characters in body/query/params (Postgres cannot store them: it was a 500).
    { provide: APP_PIPE, useClass: NoNullBytesPipe },
  ],
})
export class AppModule {}
