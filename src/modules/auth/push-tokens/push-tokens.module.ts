import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PushToken } from './entities/push-token.entity.js';
import { PushTokensRepository } from './repositories/push-tokens.repository.js';
import { PushTokensService } from './services/push-tokens.service.js';
import { PushTokensController } from './controllers/push-tokens.controller.js';

@Module({
    imports:     [TypeOrmModule.forFeature([PushToken])],
    controllers: [PushTokensController],
    providers:   [PushTokensRepository, PushTokensService],
    exports:     [PushTokensService],
})
export class PushTokensModule {}
