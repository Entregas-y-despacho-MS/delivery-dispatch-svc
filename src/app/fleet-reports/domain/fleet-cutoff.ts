import { FutureCutoffException } from '../exceptions/index.js';
import type { FleetAvailabilityCutoffDto } from '../dto/fleet-availability.dto.js';

/**
 * The cut-off of the availability (ST-303.1). Only the current vehicle status is stored (no history), so the day
 * asked for is `current` when it is today (Bolivia) and `past` when it is earlier; a day after today is `CUTOFF_IN_FUTURE`.
 * Both are `YYYY-MM-DD`, so they compare as text. Pure.
 */
export function resolveCutoff(cutoff: string | undefined, today: string): FleetAvailabilityCutoffDto {
    const date = cutoff ?? today;
    if (date > today) throw new FutureCutoffException();
    return { date, kind: date === today ? 'current' : 'past' };
}
