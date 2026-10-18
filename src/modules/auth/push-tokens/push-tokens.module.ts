import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PushToken } from './entities/push-token.entity.js';
import { PushTokensRepository } from './repositories/push-tokens.repository.js';

@Module({
    imports:   [TypeOrmModule.forFeature([PushToken])],
    providers: [PushTokensRepository],
    exports:   [PushTokensRepository],
})
export class PushTokensModule {}
