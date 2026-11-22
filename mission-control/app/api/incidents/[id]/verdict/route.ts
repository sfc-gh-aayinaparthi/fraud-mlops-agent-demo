import { asUser, handle, identity } from '@/lib/api';

export const dynamic = 'force-dynamic';

const VERDICTS = ['correct', 'partially_correct', 'wrong', 'not_an_incident'];

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = (await req.json()) as { verdict?: string; note?: string };
  if (!body.verdict || !VERDICTS.includes(body.verdict)) throw new Error('invalid verdict');
  const rows = await asUser('CALL MLOPS_CONTROL.CORE.SET_HUMAN_VERDICT(?, ?, ?)', [id, body.verdict, (body.note ?? '').slice(0, 2000)]);
  return { result: Object.values(rows[0] ?? {})[0], identity: identity() };
});
