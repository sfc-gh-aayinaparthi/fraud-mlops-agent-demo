import { handle } from '@/lib/api';
import { incidents } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async (req: Request) => {
  const u = new URL(req.url);
  return { rows: await incidents(u.searchParams.get('system') ?? undefined, Number(u.searchParams.get('limit') ?? 50)) };
});
