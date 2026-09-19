import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfig } from './services/app.config.js';
import { envValidation } from './env.validation.js';

const CONFIG_PROVIDERS = [AppConfig];

// @Global() makes CONFIG_PROVIDERS available app-wide without re-importing this module.
// ConfigModule.isGlobal makes ConfigService available — these are two separate things.
@Global()
@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal:         true,
            envFilePath:      '.env',
            validationSchema: envValidation,
        }),
    ],
    providers: CONFIG_PROVIDERS,
    exports:   CONFIG_PROVIDERS,
})
export class AppConfigModule {}
