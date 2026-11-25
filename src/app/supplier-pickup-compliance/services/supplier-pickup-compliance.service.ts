import { Injectable } from '@nestjs/common';
import { assertSlaRange } from '../../sla-report/domain/sla-date-range.js';
import { buildComplianceReport, type ComplianceQuery, type SupplierPickupComplianceReport } from '../domain/compliance-report.js';
import { EXCEPTION_LIST_DEFAULT_LIMIT } from '../dto/supplier-pickup-compliance-params.dto.js';
import { SupplierPickupComplianceRepository } from '../repositories/supplier-pickup-compliance.repository.js';

/**
 * ST-305.1 — compliance and exceptions of supplier-pickup appointments (ES-305, section 5A). Nothing is cached: an open
 * overdue pickup changes every minute and a cached figure would hide it.
 */
@Injectable()
export class SupplierPickupComplianceService {
    constructor(private readonly repository: SupplierPickupComplianceRepository) {}

    async getCompliance(query: ComplianceQuery, exceptionLimit: number = EXCEPTION_LIST_DEFAULT_LIMIT, now: Date = new Date()): Promise<SupplierPickupComplianceReport> {
        assertSlaRange(query.from, query.to);
        const rows = await this.repository.findAppointments(query);
        return buildComplianceReport(query, rows, now, exceptionLimit);
    }
}
