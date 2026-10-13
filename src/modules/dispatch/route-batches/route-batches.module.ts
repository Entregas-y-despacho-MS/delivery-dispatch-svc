import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RouteBatch } from './entities/route-batch.entity.js';
import { RouteBatchEvent } from './entities/route-batch-event.entity.js';
import { RouteBatchesController } from './controllers/route-batches.controller.js';
import { RouteBatchReviewerService } from './services/route-batch-reviewer.service.js';

// Reviewer assignment (ST-50.4, D-42). The batch planner (ST-50.2) calls RouteBatchReviewerService.assignReviewer.
@Module({
    imports:   [TypeOrmModule.forFeature([RouteBatch, RouteBatchEvent])],
    controllers: [RouteBatchesController],
    providers: [RouteBatchReviewerService],
    exports:   [RouteBatchReviewerService],
})
export class RouteBatchesModule {}
