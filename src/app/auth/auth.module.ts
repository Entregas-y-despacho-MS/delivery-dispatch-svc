import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { JwtConfig } from './config/jwt.config.js';
import { UsersModule } from '../../modules/auth/users/users.module.js';
import { AuthService } from './services/auth.service.js';
import { TwoFactorService } from './services/two-factor.service.js';
import { AuthController } from './controllers/auth.controller.js';
import { TwoFactorController } from './controllers/two-factor.controller.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { PasswordChangeGuard } from './guards/password-change.guard.js';

@Module({
    imports: [
        PassportModule,
        JwtModule.registerAsync({
            // extraProviders bridges the gap between JwtModule's internal module and AuthModule's DI scope.
            extraProviders: [JwtConfig],
            inject:         [JwtConfig],
            useFactory: (cfg: JwtConfig) => ({
                secret:      cfg.secret,
                signOptions: { expiresIn: cfg.expiresIn as any },
            }),
        }),
        ThrottlerModule.forRootAsync({
            // ThrottlerAsyncOptions has no extraProviders hatch (unlike JwtModule/MailerModule) —
            // inject ConfigService directly, it's already global via AppConfigModule.
            imports: [],
            inject:  [ConfigService],
            // Applies to every route by default — routes that need a stricter limit
            // (e.g. OTP confirmation) override it with @Throttle({ default: { limit, ttl } }).
            useFactory: (cfg: ConfigService) => ({
                throttlers: [{
                    ttl:   cfg.get<number>('THROTTLE_TTL_MS', 60000),
                    limit: cfg.get<number>('THROTTLE_LIMIT', 100),
                }],
            }),
        }),
        UsersModule,
    ],
    providers: [
        // APP_GUARD applies these guards globally. Remove this module from AppModule to disable them.
        // ThrottlerGuard goes first: rejected requests (401/403) count toward the rate limit too, so nobody can
        // hammer an endpoint (and fill the audit trail of sensitive actions) without a valid token.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PasswordChangeGuard }, // after JwtAuthGuard: needs request.user
        { provide: APP_GUARD, useClass: RolesGuard },
        JwtConfig,
        AuthService,
        TwoFactorService,
        JwtStrategy,
    ],
    controllers: [AuthController, TwoFactorController],
    exports:     [JwtStrategy, PassportModule],
})
export class AuthModule {}
