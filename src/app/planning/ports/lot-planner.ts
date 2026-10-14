import type { PlanInput, PlanProposal } from '../domain/plan-types.js';

/**
 * Contract of the batch generator (D-41, plan §5.1). The proposal is computed without touching the
 * database, so any engine can replace the own insertion heuristic (VROOM, A-6) without changing the
 * repository, the writer or the scheduler.
 *
 * An implementation asks OSRM for every matrix it needs before returning; if OSRM does not answer it
 * throws and nothing has been written.
 */
export abstract class LotPlanner {
    abstract plan(input: PlanInput): Promise<PlanProposal>;
}
