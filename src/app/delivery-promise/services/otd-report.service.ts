import { Injectable } from '@nestjs/common';
import { assertSlaRange } from '../../sla-report/domain/sla-date-range.js';
import { OtdBasis } from '../domain/otd-basis.js';
import { buildOtdReport } from '../domain/otd-metrics.js';
import type { DeliveryPromiseFilters } from '../repositories/delivery-promise.sql.js';
import { OtdRepository } from '../repositories/otd.repository.js';
import { FirstAttemptService } from './first-attempt.service.js';
import type { OtdReportDto } from '../dto/otd-report.dto.js';

/**
 * ST-301.1 — the OTD of the dashboard «Resumen operativo y nivel de servicio». It is a different rate from the
 * punctuality of ES-54 (`/reports/sla`), which is left untouched: each answer says which `basis` it was measured on.
 * Nothing is cached: the open overdue dispatches change every minute, and a cached figure would hide them.
 */
@Injectable()
export class OtdReportService {
    constructor(
        private readonly repository: OtdRepository,
        private readonly firstAttempts: FirstAttemptService,
    ) {}

    /** The OTD by cohort of promise: delivered inside the window / eligible dispatches whose promise expired in the range, open ones included. */
    async getPromiseOtd(filters: DeliveryPromiseFilters, now: Date = new Date()): Promise<OtdReportDto> {
        assertSlaRange(filters.from, filters.to);
        const [counts, firstAttempt] = await Promise.all([this.repository.countCohort(filters, now), this.firstAttempts.getFirstAttempt(filters)]);
        return buildOtdReport(OtdBasis.PROMISE, filters, counts, now, firstAttempt);
    }

    /**
     * The historic punctuality of the completed deliveries by closing time (`deliveredAt`): the ES-54 indicator as its own
     * query, with its own denominator (the delivered ones), never mixed with the OTD by cohort.
     */
    async getDeliveredAtOtd(filters: DeliveryPromiseFilters, now: Date = new Date()): Promise<OtdReportDto> {
        assertSlaRange(filters.from, filters.to);
        const [counts, firstAttempt] = await Promise.all([this.repository.countDeliveredAt(filters, now), this.firstAttempts.getFirstAttempt(filters)]);
        return buildOtdReport(OtdBasis.DELIVERED_AT, filters, counts, now, firstAttempt);
    }

    /** Either rate, as the `basis` of the request says; the OTD by cohort of promise when it does not say. */
    async getOtd(filters: DeliveryPromiseFilters, basis: OtdBasis = OtdBasis.PROMISE, now: Date = new Date()): Promise<OtdReportDto> {
        return basis === OtdBasis.DELIVERED_AT ? await this.getDeliveredAtOtd(filters, now) : await this.getPromiseOtd(filters, now);
    }
}
