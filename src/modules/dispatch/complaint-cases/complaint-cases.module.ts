import { Module } from '@nestjs/common';
import { ComplaintCasesController } from './controllers/complaint-cases.controller.js';
import { ComplaintCasesService } from './services/complaint-cases.service.js';

// ST-45.2: complaint inbox. Read side over cases, dispatches, zones, batches and users through the DataSource.
// The commands (assign, start, verdict) join this module in the next stage.
@Module({
    controllers: [ComplaintCasesController],
    providers:   [ComplaintCasesService],
    exports:     [ComplaintCasesService],
})
export class ComplaintCasesModule {}
