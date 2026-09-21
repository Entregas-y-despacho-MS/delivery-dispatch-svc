import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from './entities/role.entity.js';
import { RolesService } from './services/roles.service.js';
import { RolesController } from './controllers/roles.controller.js';

@Module({
    imports:     [TypeOrmModule.forFeature([Role])],
    controllers: [RolesController],
    providers:   [RolesService],
    exports:     [RolesService],
})
export class RolesModule {}
