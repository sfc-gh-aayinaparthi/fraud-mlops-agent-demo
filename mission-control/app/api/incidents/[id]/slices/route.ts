import { handle } from '@/lib/api';
import { q, slices } from '@/lib/data';

export const dynamic = 'force-dynamic';

/** Slice the system's configured outcome over the incident window. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const [inc] = await q<{ system_id: string; opened_at: string; end_ts: string }>(
    `SELECT system_id, opened_at, COALESCE(resolved_at, DATEADD(minute, 5, last_signal_at)) AS end_ts
     FROM MLOPS_CONTROL.CORE.INCIDENTS WHERE incident_id = ?`, [id]);
  if (!inc) throw new Error('incident does not exist or not authorized');
  const cfg = await q<{ entity_id: string; outcome_label: string }>(
    'SELECT entity_id, outcome_label FROM MLOPS_CONTROL.CORE.SLICE_CONFIG WHERE system_id = ?', [inc.system_id]);
  if (!cfg.length) return { rows: [], configured: false };
  const rows = await slices(cfg[0].entity_id, String(inc.opened_at), String(inc.end_ts));
  return { rows, configured: true, outcome: cfg[0].outcome_label, window: [inc.opened_at, inc.end_ts] };
});
