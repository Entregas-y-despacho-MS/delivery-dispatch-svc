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
import { DispatchReservationsModule } from './modules/dispatch/dispatch-reservations/dispatch-reservations.module.js';

@Module({
    imports: [
        // Global, registered once here — see plugins/socket/socket.module.ts for why it isn't
        // re-registered there too. Used to decouple the socket plugin (generic transport) from the
        // business modules that react to a connection (e.g. app/tracking's 'dispatch-board' room).
        EventEmitterModule.forRoot(),
        AppConfigModule,
        HealthModule,
        DatabaseModule,
        SettingsModule,
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
        DispatchReservationsModule,
    ],
    providers: [
        // Rejects NUL characters in body/query/params (Postgres cannot store them: it was a 500).
        { provide: APP_PIPE, useClass: NoNullBytesPipe },
    ],
})
export class AppModule {}
