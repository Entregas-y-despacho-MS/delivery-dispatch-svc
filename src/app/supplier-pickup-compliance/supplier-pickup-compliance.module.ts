import { Module } from '@nestjs/common';
import { SupplierPickupComplianceController } from './controllers/supplier-pickup-compliance.controller.js';
import { SupplierPickupComplianceRepository } from './repositories/supplier-pickup-compliance.repository.js';
import { SupplierPickupComplianceService } from './services/supplier-pickup-compliance.service.js';

/** ST-305.1 (ES-305, Dashboard 5, section 5A): compliance and exceptions of supplier-pickup appointments. Read-only: it owns no table and has no cache. */
@Module({
    controllers: [SupplierPickupComplianceController],
    providers: [SupplierPickupComplianceRepository, SupplierPickupComplianceService],
})
export class SupplierPickupComplianceModule {}
