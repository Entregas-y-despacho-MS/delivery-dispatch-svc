import { Injectable } from '@nestjs/common';
import { todayInOperatingTimeZone } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { exceptionReason } from '../domain/exception-reasons.js';
import { classifyDispatch, countByStage, PipelineStage, type PipelineClassification } from '../domain/pipeline-stage.js';
import type { PipelineBatchDto, PipelineDispatchDto, PlanningPipelineResponseDto } from '../dto/planning-pipeline.dto.js';
import type { PlanningPipelineParamsDto } from '../dto/planning-pipeline-params.dto.js';
import { PipelineRepository, type BatchLoad, type PipelineCandidate } from '../repositories/pipeline.repository.js';

/**
 * ST-302.1 (ES-302, Dashboard 2) — the planning pipeline by individual dispatch: where each dispatch is (ready without
 * batch, provisional or in review, confirmed, in execution, exception) and how loaded its batch is, kg and m³ apart.
 * The unit of every count is the dispatch; the batch only comes as detail. Read-only and not cached.
 */
@Injectable()
export class PlanningPipelineService {
    constructor(private readonly repository: PipelineRepository) {}

    async getPipeline(params: PlanningPipelineParamsDto): Promise<PlanningPipelineResponseDto> {
        const date = params.date ?? todayInOperatingTimeZone();
        const candidates = await this.repository.findCandidates({ date, zoneId: params.zoneId, warehouseId: params.warehouseId, shift: params.shift });

        const batchIds = [...new Set(candidates.flatMap((candidate) => (candidate.routeBatchId === null ? [] : [candidate.routeBatchId])))];
        const loads = await this.repository.loadBatches(batchIds);

        const classified = candidates
            .map((candidate) => ({ candidate, result: this.classify(candidate, loads) }))
            .filter((item): item is { candidate: PipelineCandidate; result: PipelineClassification & { stage: PipelineStage } } => item.result.stage !== null);

        // The summary counts every stage of the other filters, so choosing a stage does not hide the rest of the pipeline.
        const byStage = countByStage(classified.map((item) => item.result.stage));
        const total = classified.length;

        const selected = params.stage === undefined ? classified : classified.filter((item) => item.result.stage === params.stage);
        const start = (params.page - 1) * params.limit;
        const page = selected.slice(start, start + params.limit);

        return {
            date,
            summary: { byStage, total },
            data: page.map(({ candidate, result }) => this.toDispatch(candidate, result)),
            batches: this.toBatches(page.map((item) => item.candidate), loads),
            meta: { page: params.page, limit: params.limit, total: selected.length, pages: Math.ceil(selected.length / params.limit) },
        };
    }

    private classify(candidate: PipelineCandidate, loads: Map<number, BatchLoad>): PipelineClassification {
        return classifyDispatch({
            status: candidate.status,
            hasZone: candidate.zone !== null,
            batchStatus: candidate.batchStatus,
            planExceptionReason: candidate.planExceptionReason,
            batchCapacity: candidate.routeBatchId === null ? null : (loads.get(candidate.routeBatchId)?.capacity ?? null),
        });
    }

    private toDispatch(candidate: PipelineCandidate, result: PipelineClassification & { stage: PipelineStage }): PipelineDispatchDto {
        return {
            dispatchId: candidate.dispatchId,
            stage: result.stage,
            status: candidate.status,
            routeBatchId: candidate.routeBatchId,
            zone: candidate.zone,
            warehouse: candidate.warehouse,
            operatingDate: candidate.operatingDate,
            shift: candidate.shift,
            vehicle: candidate.vehicle,
            driver: candidate.driver,
            exception: result.stage === PipelineStage.EXCEPTION ? { codes: result.exceptionCodes, reason: exceptionReason(result.exceptionCodes) } : null,
            detailPath: `/dispatches/${candidate.dispatchId}/detail`,
        };
    }

    private toBatches(candidates: PipelineCandidate[], loads: Map<number, BatchLoad>): PipelineBatchDto[] {
        const batches = new Map<number, PipelineBatchDto>();
        for (const candidate of candidates) {
            const id = candidate.routeBatchId;
            if (id === null || batches.has(id)) continue;
            const load = loads.get(id);
            batches.set(id, {
                id,
                status: candidate.batchStatus ?? '',
                version: candidate.batchVersion ?? 0,
                shiftDate: candidate.batchShiftDate ?? '',
                vehicle: candidate.vehicle,
                driver: candidate.driver,
                capacity: load?.capacity ?? null,
                dispatchCount: load?.dispatchCount ?? 0,
            });
        }
        return [...batches.values()];
    }
}
