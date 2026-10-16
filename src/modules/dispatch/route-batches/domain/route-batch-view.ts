import type { RouteCapacityReport } from './route-capacity.js';

export interface RouteBatchOccupancy {
  weight: { actual: number; capacity: number; usedPercent: number };
  volume: { actual: number; capacity: number; usedPercent: number };
  estimatedDispatchIds: number[];
  assignable: boolean;
}

export interface RouteBatchValidation {
  result: 'validated' | 'failed';
  occurredAt: Date;
  reason: string | null;
  failures: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
}

export interface CutoffEventRow {
  eventType: string;
  createdAt: Date;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

/** Shortens a capacity report to what a list row shows; a batch without vehicle has no report. */
export function summarizeOccupancy(report: RouteCapacityReport | null): RouteBatchOccupancy | null {
  if (!report) return null;
  const pick = ({ actual, capacity, usedPercent }: RouteCapacityReport['weight']) => ({
    actual,
    capacity,
    usedPercent,
  });
  return {
    weight: pick(report.weight),
    volume: pick(report.volume),
    estimatedDispatchIds: report.estimatedDispatchIds,
    assignable: report.assignable,
  };
}

/** Reads the system validation from the last `cutoff_validated` / `cutoff_failed` event of a batch. */
export function toValidation(event: CutoffEventRow | null): RouteBatchValidation | null {
  if (!event) return null;
  if (event.eventType !== 'cutoff_validated' && event.eventType !== 'cutoff_failed') return null;
  return {
    result: event.eventType === 'cutoff_validated' ? 'validated' : 'failed',
    occurredAt: event.createdAt,
    reason: event.reason,
    failures: issues(event.metadata?.failures),
    warnings: issues(event.metadata?.warnings),
  };
}

function issues(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}
