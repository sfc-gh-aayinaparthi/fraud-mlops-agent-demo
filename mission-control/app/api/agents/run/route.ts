import { asUser, handle, identity } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Start an agent run now, as the signed-in user (needs MLOPS_APPROVER). */
export const POST = handle(async (req: Request) => {
  const { agent_id } = (await req.json()) as { agent_id?: string };
  if (!agent_id) throw new Error('agent_id required');
  const rows = await asUser('CALL MLOPS_CONTROL.CORE.RUN_AGENT(?, CURRENT_USER())', [agent_id]);
  return { result: Object.values(rows[0] ?? {})[0], requested_at: new Date().toISOString(), identity: identity() };
});
