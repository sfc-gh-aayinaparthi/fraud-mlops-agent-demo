import { handle } from '@/lib/api';
import { heatmap, q } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const [inc] = await q<{ system_id: string; opened_at: string }>(
    'SELECT system_id, opened_at FROM MLOPS_CONTROL.CORE.INCIDENTS WHERE incident_id = ?', [id]);
  if (!inc) throw new Error('incident does not exist or not authorized');
  return { rows: await heatmap(inc.system_id, String(inc.opened_at), 2) };
});
