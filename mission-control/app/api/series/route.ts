import { handle } from '@/lib/api';
import { series } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async (req: Request) => {
  const u = new URL(req.url);
  const metrics = (u.searchParams.get('metrics') ?? '').split(',').filter(Boolean).slice(0, 30);
  const hours = Math.min(48, Math.max(1, Number(u.searchParams.get('hours') ?? 6)));
  const around = u.searchParams.get('around') ?? undefined;
  return { rows: await series(metrics, hours, around) };
});
