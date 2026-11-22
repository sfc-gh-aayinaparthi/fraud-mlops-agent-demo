/** State vocabulary shared by every screen. Colour is reserved for state. */
export type Status = 'healthy' | 'warning' | 'critical' | 'unmonitored' | 'unknown';

export const STATUS_LABEL: Record<Status, string> = {
  healthy: 'Healthy',
  warning: 'Degraded',
  critical: 'Critical',
  unmonitored: 'Unmonitored',
  unknown: 'Unknown',
};

/** CSS variable per status, for both Tailwind (via style) and three.js materials. */
export const STATUS_VAR: Record<Status, string> = {
  healthy: 'var(--brand)',
  warning: 'var(--warning)',
  critical: 'var(--critical)',
  unmonitored: 'var(--muted-foreground)',
  unknown: 'var(--muted-foreground)',
};

export const STAGE_ORDER = ['source', 'feature', 'model', 'serving', 'decision', 'orchestration', 'agent'];
export const STAGE_LABEL: Record<string, string> = {
  source: 'Sources', feature: 'Features', model: 'Models', serving: 'Serving',
  decision: 'Decisions', orchestration: 'Orchestration', agent: 'Agents',
};

export const VERDICT_LABEL: Record<string, string> = {
  confirmed: 'Cause confirmed',
  unconfirmed: 'Cause unconfirmed',
  healthy: 'No incident found',
};

export function fmtMetric(v: unknown, unit?: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (unit) {
    case 'share':
      return `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;
    case 'ratio':
      return `${n.toFixed(2)}x`;
    case 'pct':
      return `${n.toFixed(n < 10 ? 1 : 0)}%`;
    case 'minutes':
      return `${Math.round(n)} min`;
    case 'txns/5m':
      return `${Math.round(n).toLocaleString()}`;
    default:
      if (Number.isInteger(n)) return n.toLocaleString();
      return Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : n.toFixed(Math.abs(n) < 1 ? 3 : 2);
  }
}
