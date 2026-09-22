import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryEvidence } from './entities/delivery-evidence.entity.js';
import { DeliveryEvidencesService } from './services/delivery-evidences.service.js';

@Module({
    imports:   [TypeOrmModule.forFeature([DeliveryEvidence])],
    providers: [DeliveryEvidencesService],
    exports:   [DeliveryEvidencesService],
})
export class DeliveryEvidencesModule {}
