import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlanningCutoffDispatch } from './entities/planning-cutoff-dispatch.entity.js';
import { PlanningCutoff } from './entities/planning-cutoff.entity.js';

/** ST-302.2 (ES-302): tables of the planning universe by cutoff. The service that writes them arrives with the capture of the cutoff. */
@Module({
    imports: [TypeOrmModule.forFeature([PlanningCutoff, PlanningCutoffDispatch])],
    exports: [TypeOrmModule],
})
export class PlanningCutoffsModule {}
