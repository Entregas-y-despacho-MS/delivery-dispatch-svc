import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module.js';
import { HealthModule } from './app/health/health.module.js';
import { DatabaseModule } from './database/database.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { UsersModule } from './modules/auth/users/users.module.js';
import { RolesModule } from './modules/auth/roles/roles.module.js';
import { DeliveryZonesModule } from './modules/catalog/delivery-zones/delivery-zones.module.js';
import { VehiclesModule } from './modules/fleet/vehicles/vehicles.module.js';
import { ServiceLevelsModule } from './modules/catalog/service-levels/service-levels.module.js';
import { AuthModule } from './app/auth/auth.module.js';
import { SyncModule } from './app/sync/sync.module.js';
import { MailerModule } from './plugins/mailer/mailer.module.js';
import { SocketModule } from './plugins/socket/socket.module.js';
import { PdfModule } from './plugins/pdf/pdf.module.js';
import { StorageModule } from './plugins/storage/storage.module.js';
import { PushModule } from './plugins/push/push.module.js';
import { OsrmModule } from './plugins/osrm/osrm.module.js';

@Module({
    imports: [
        AppConfigModule,
        HealthModule,
        DatabaseModule,
        SettingsModule,
        UsersModule,
        RolesModule,
        DeliveryZonesModule,
        VehiclesModule,
        ServiceLevelsModule,
        AuthModule,
        SyncModule,
        MailerModule.register(),
        SocketModule,
        PdfModule,
        StorageModule.register(),
        PushModule.register(),
        OsrmModule,
    ],
})
export class AppModule {}
