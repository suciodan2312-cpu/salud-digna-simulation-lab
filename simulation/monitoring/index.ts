import type { Observation } from '../adapters/transport/index.js';

// Functional runs only. k6 will own distributions and thresholds for load runs.
export class FunctionalMetrics {
  private readonly counts = new Map<string, { attempts: number; maxMs: number; statuses: Record<number, number> }>();
  observe = ({ operation, status, elapsedMs }: Observation) => {
    const row = this.counts.get(operation) ?? { attempts: 0, maxMs: 0, statuses: {} };
    row.attempts++;
    row.maxMs = Math.max(row.maxMs, Math.round(elapsedMs));
    row.statuses[status] = (row.statuses[status] ?? 0) + 1;
    this.counts.set(operation, row);
  };
  summary() { return Object.fromEntries(this.counts); }
}
