import { handle } from '@/lib/api';
import { freshness, kpis, system } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const [s, k, fresh] = await Promise.all([system(id), kpis(id), freshness()]);
  if (!s.system) throw new Error(`system ${id} does not exist or not authorized`);
  return { ...s, kpis: k, freshness: fresh };
});
