import { Module } from '@nestjs/common';
import { RouteBatchClosingService } from './services/route-batch-closing.service.js';

@Module({
    providers: [RouteBatchClosingService],
    exports: [RouteBatchClosingService],
})
export class RouteBatchClosingModule {}
