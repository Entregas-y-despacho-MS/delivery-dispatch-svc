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
import { PushTokensModule } from './modules/auth/push-tokens/push-tokens.module.js';
import { DeliveryZonesModule } from './modules/catalog/delivery-zones/delivery-zones.module.js';
import { VehiclesModule } from './modules/fleet/vehicles/vehicles.module.js';
import { ServiceLevelsModule } from './modules/catalog/service-levels/service-levels.module.js';
import { IncidentReasonsModule } from './modules/catalog/incident-reasons/incident-reasons.module.js';
import { RescheduleReasonsModule } from './modules/catalog/reschedule-reasons/reschedule-reasons.module.js';
import { WarehousesModule } from './modules/catalog/warehouses/warehouses.module.js';
import { VehicleIncidentTypesModule } from './modules/fleet/vehicle-incident-types/vehicle-incident-types.module.js';
import { VehicleMaintenancesModule } from './modules/fleet/vehicle-maintenances/vehicle-maintenances.module.js';
import { AuthModule } from './app/auth/auth.module.js';
import { TrackingModule } from './app/tracking/tracking.module.js';
import { FleetModule } from './app/fleet/fleet.module.js';
import { MailerModule } from './plugins/mailer/mailer.module.js';
import { SocketModule } from './plugins/socket/socket.module.js';
import { PdfModule } from './plugins/pdf/pdf.module.js';
import { StorageModule } from './plugins/storage/storage.module.js';
import { PushModule } from './plugins/push/push.module.js';
import { OsrmModule } from './plugins/osrm/osrm.module.js';
import { PendingOrdersModule } from './modules/dispatch/pending-orders/pending-orders.module.js';
import { DispatchHistoryModule } from './modules/dispatch/dispatch-history/dispatch-history.module.js';
import { PickupSchedulingModule } from './modules/dispatch/pickup-scheduling/pickup-scheduling.module.js';
import { RouteAssignmentModule } from './app/route-assignment/route-assignment.module.js';
import { RouteBatchesModule } from './modules/dispatch/route-batches/route-batches.module.js';
import { DispatchReservationsModule } from './modules/dispatch/dispatch-reservations/dispatch-reservations.module.js';
import { CacheModule } from './plugins/cache/cache.module.js';
import { MessagingModule } from './plugins/messaging/messaging.module.js';
import { InboundMessagesModule } from './modules/messaging/inbound-messages/inbound-messages.module.js';
import { OutboundMessagesModule } from './modules/messaging/outbound-messages/outbound-messages.module.js';
import { SalesOrderIntakeModule } from './modules/messaging/sales-order-intake/sales-order-intake.module.js';
import { IncompleteOrderRecoveryModule } from './modules/messaging/incomplete-order-recovery/incomplete-order-recovery.module.js';
import { RmaPickupIntakeModule } from './modules/messaging/rma-pickup-intake/rma-pickup-intake.module.js';
import { WarehouseReceiptIntakeModule } from './modules/messaging/warehouse-receipt-intake/warehouse-receipt-intake.module.js';
import { SchedulerModule } from './app/scheduler/scheduler.module.js';
import { PlanningModule } from './app/planning/planning.module.js';
import { PromiseFirmingModule } from './app/promise-firming/promise-firming.module.js';
import { FinalReviewModule } from './app/final-review/final-review.module.js';
import { RouteBatchCorrectionModule } from './app/route-batch-correction/route-batch-correction.module.js';
import { DispatchRescheduleModule } from './app/dispatch-reschedule/dispatch-reschedule.module.js';
import { RouteCutoffModule } from './app/route-cutoff/route-cutoff.module.js';
import { PublicTrackingModule } from './app/public-tracking/public-tracking.module.js';
import { CustomerChangeRequestsModule } from './app/customer-change-requests/customer-change-requests.module.js';
import { DispatchStatusModule } from './app/dispatch-status/dispatch-status.module.js';
import { DispatchOtpModule } from './app/dispatch-otp/dispatch-otp.module.js';
import { DriverMetricsModule } from './app/driver-metrics/driver-metrics.module.js';
import { DispatchEvidenceModule } from './app/dispatch-evidence/dispatch-evidence.module.js';
import { AuditLogsModule } from './modules/audit/audit-logs/audit-logs.module.js';
import { DispatchEventsAppModule } from './app/dispatch-events/dispatch-events.module.js';
import { DispatchIncidentsAppModule } from './app/dispatch-incidents/dispatch-incidents.module.js';
import { SupplierPickupModule } from './app/supplier-pickup/supplier-pickup.module.js';
import { PickupOrdersModule } from './app/pickup-orders/pickup-orders.module.js';
import { SlaReportModule } from './app/sla-report/sla-report.module.js';
import { FleetKpisModule } from './app/fleet-kpis/fleet-kpis.module.js';

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
    RmaPickupIntakeModule,
    WarehouseReceiptIntakeModule,
    HealthModule,
    DatabaseModule,
    SettingsModule,
    SchedulerModule,
    PlanningModule,
    PromiseFirmingModule,
    PublicTrackingModule,
    CustomerChangeRequestsModule,
    RouteCutoffModule,
    DispatchStatusModule,
    DispatchOtpModule,
    DriverMetricsModule,
    SlaReportModule,
    FleetKpisModule,
    DispatchEvidenceModule,
    AuditLogsModule,
    RouteBatchCorrectionModule,
    DispatchRescheduleModule,
    FinalReviewModule,
    UsersModule,
    RolesModule,
    PushTokensModule,
    DeliveryZonesModule,
    VehiclesModule,
    ServiceLevelsModule,
    IncidentReasonsModule,
    RescheduleReasonsModule,
    WarehousesModule,
    VehicleIncidentTypesModule,
    VehicleMaintenancesModule,
    AuthModule,
    TrackingModule,
    FleetModule,
    DispatchEventsAppModule,
    DispatchIncidentsAppModule,
    SupplierPickupModule,
    PickupOrdersModule,
    MailerModule.register(),
    SocketModule,
    PdfModule,
    StorageModule.register(),
    PushModule.register(),
    OsrmModule,
    PendingOrdersModule,
    DispatchHistoryModule,
    RouteBatchesModule,
    DispatchReservationsModule,
    PickupSchedulingModule,
    RouteAssignmentModule,
  ],
  providers: [
    // Rejects NUL characters in body/query/params (Postgres cannot store them: it was a 500).
    { provide: APP_PIPE, useClass: NoNullBytesPipe },
  ],
})
export class AppModule {}
