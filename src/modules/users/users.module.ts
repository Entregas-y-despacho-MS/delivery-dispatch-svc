import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity.js';
import { PasswordHistory } from './entities/password-history.entity.js';
import { UsersService } from './services/users.service.js';
import { UsersController } from './controllers/users.controller.js';

@Module({
    imports:     [TypeOrmModule.forFeature([User, PasswordHistory])],
    controllers: [UsersController],
    providers:   [UsersService],
    exports:     [UsersService],
})
export class UsersModule {}
