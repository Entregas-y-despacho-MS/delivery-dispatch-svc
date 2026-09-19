import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseConfig } from './config/database.config.js';

/**
 * Configures TypeORM and exposes DataSource for transactions.
 *
 * Usage in services:
 *   constructor(@InjectDataSource() private readonly dataSource: DataSource) {}
 *
 *   await this.dataSource.transaction(async (manager) => {
 *       await this.usersService.create(dto, { manager });
 *       await this.ordersService.create(orderDto, { manager });
 *   });
 */
@Module({
    imports: [
        TypeOrmModule.forRootAsync({
            // extraProviders: TypeOrmModule.forRootAsync creates an internal module
            // that has no access to DatabaseModule providers — extraProviders bridges that gap.
            extraProviders: [DatabaseConfig],
            inject:         [DatabaseConfig],
            useFactory: (db: DatabaseConfig) => ({
                type:             db.type as any,
                host:             db.host,
                port:             db.port,
                username:         db.username,
                password:         db.password,
                database:         db.database,
                autoLoadEntities: true,
                synchronize:      false,
                logging:          db.logging,
            }),
        }),
    ],
    providers: [DatabaseConfig],
    exports:   [TypeOrmModule],
})
export class DatabaseModule {}
