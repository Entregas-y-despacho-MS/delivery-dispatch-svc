export const INCIDENT_REPORTED_EVENT = 'dispatch.incident_reported';
export const COMPANY_FAILURE_REASON = 'INC-COMP-FAILURE';
export const MAX_INCIDENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Match RF-U13 sync's incident clock tolerance: offline incidents can arrive later, and device clocks drift.
export const MAX_INCIDENT_FUTURE_MS = 60 * 60 * 1000;

export function assertPlausibleIncidentTime(occurredAt: Date, now: Date): void {
    const timestamp = occurredAt.getTime();
    if (!Number.isFinite(timestamp) || timestamp > now.getTime() + MAX_INCIDENT_FUTURE_MS || timestamp < now.getTime() - MAX_INCIDENT_AGE_MS) {
        throw new RangeError('occurredAt is outside the allowed reporting window.');
    }
}

export function requiresIncidentObservations(reasonName: string): boolean {
    return reasonName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase() === 'otro';
}
