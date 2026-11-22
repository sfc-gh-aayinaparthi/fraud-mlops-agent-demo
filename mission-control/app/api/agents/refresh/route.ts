import { handle } from '@/lib/api';
import { q } from '@/lib/data';

export const dynamic = 'force-dynamic';

/** Pull the latest trace lines from agent workspaces (used while a run is live). */
export const POST = handle(async () => {
  await q('CALL MLOPS_CONTROL.CORE.REFRESH_AGENT_EVENTS()');
  return { ok: true };
});
