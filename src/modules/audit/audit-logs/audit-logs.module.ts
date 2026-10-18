import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboundMessage } from '../../messaging/outbound-messages/entities/outbound-message.entity.js';
import { AuditLog } from './entities/audit-log.entity.js';
import { AuditLogsController } from './controllers/audit-logs.controller.js';
import { AuditLogsService } from './services/audit-logs.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, OutboundMessage])],
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
})
export class AuditLogsModule {}
