import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from './entities/role.entity.js';
import { RolesService } from './services/roles.service.js';
import { UsersModule } from '../users/users.module.js';
import { RolesController } from './controllers/roles.controller.js';

@Module({
    imports:     [TypeOrmModule.forFeature([Role]), UsersModule], // UsersModule: the user counts of each role
    controllers: [RolesController],
    providers:   [RolesService],
    exports:     [RolesService],
})
export class RolesModule {}
