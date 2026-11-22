/**
 * Control-plane timestamps are TIMESTAMP_NTZ in the account's wall-clock time
 * (Australia/Sydney here). The driver serialises them as if they were UTC, so we
 * format with timeZone UTC to show the wall-clock value unchanged, and compute
 * "ago" against the server's own NTZ now.
 */
const T = new Intl.DateTimeFormat('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const DT = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const DTS = new Intl.DateTimeFormat('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' });

/** Parse an NTZ value ('2026-11-22T13:00:00.000000000', no zone) as a wall-clock instant. */
function parse(v: unknown): Date {
  if (v instanceof Date) return v;
  const s = String(v).replace(' ', 'T');
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(s);
  return new Date(zoned ? s : `${s.slice(0, 23)}Z`);
}

export const ms = (v: unknown) => (v ? parse(v).getTime() : NaN);
export const hhmm = (v: unknown) => (v ? T.format(parse(v)) : '—');
export const hhmmss = (v: unknown) => (v ? DTS.format(parse(v)) : '—');
export const dayTime = (v: unknown) => (v ? DT.format(parse(v)) : '—');

export function ago(v: unknown, now: unknown): string {
  const d = (ms(now) - ms(v)) / 1000;
  if (!Number.isFinite(d)) return '—';
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

export function minutesBetween(a: unknown, b: unknown): number | null {
  const d = (ms(b) - ms(a)) / 60000;
  return Number.isFinite(d) ? Math.round(d) : null;
}

/** Format an NTZ wall-clock Date back to 'YYYY-MM-DD HH:MI:SS' for bind parameters. */
export const ntz = (v: unknown) => parse(v).toISOString().slice(0, 19).replace('T', ' ');
