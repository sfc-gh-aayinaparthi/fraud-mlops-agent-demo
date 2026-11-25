import { handle } from '@/lib/api';
import { freshness, incidents } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async (req: Request) => {
  const u = new URL(req.url);
  const [rows, f] = await Promise.all([incidents(u.searchParams.get('system') ?? undefined, Number(u.searchParams.get('limit') ?? 50)), freshness()]);
  return { rows, now_ts: f?.now_ts };
});
