import { Module } from '@nestjs/common';
import { PlanningPipelineController } from './controllers/planning-pipeline.controller.js';
import { PipelineRepository } from './repositories/pipeline.repository.js';
import { PlanningPipelineService } from './services/planning-pipeline.service.js';

/** ST-302.1 (ES-302): planning pipeline by individual dispatch. Read-only: it owns no table and has no cache. */
@Module({
    controllers: [PlanningPipelineController],
    providers: [PipelineRepository, PlanningPipelineService],
})
export class PlanningPipelineModule {}
