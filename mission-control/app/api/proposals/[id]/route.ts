import { asUser, handle, identity } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Approve or reject an agent proposal. Authorisation is the MLOPS_APPROVER grant on the procedure. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = (await req.json()) as { decision?: string; note?: string };
  if (body.decision !== 'approve' && body.decision !== 'reject') throw new Error('decision must be approve or reject');
  const rows = await asUser('CALL MLOPS_CONTROL.CORE.EXECUTE_ACTION(?, ?, ?)', [decodeURIComponent(id), body.decision, (body.note ?? '').slice(0, 2000)]);
  const raw = Object.values(rows[0] ?? {})[0];
  return { result: typeof raw === 'string' ? JSON.parse(raw) : raw, identity: identity() };
});
