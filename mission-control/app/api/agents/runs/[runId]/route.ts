import { handle } from '@/lib/api';
import { agentRun } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ runId: string }> }) => {
  const { runId } = await ctx.params;
  return agentRun(runId);
});
