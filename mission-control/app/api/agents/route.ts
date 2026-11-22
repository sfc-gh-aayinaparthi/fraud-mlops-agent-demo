import { handle } from '@/lib/api';
import { agentRuns, agents, freshness } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const [a, runs, fresh] = await Promise.all([agents(), agentRuns(40), freshness()]);
  return { agents: a, runs, freshness: fresh };
});
