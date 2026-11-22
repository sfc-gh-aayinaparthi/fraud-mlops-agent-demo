import { handle } from '@/lib/api';
import { incident } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const d = await incident(id);
  if (!d) throw new Error('incident does not exist or not authorized');
  return d;
});
