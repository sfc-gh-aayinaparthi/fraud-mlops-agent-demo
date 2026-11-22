import { handle } from '@/lib/api';
import { abnormalNow, fleet, freshness } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const [f, abnormal, fresh] = await Promise.all([fleet(), abnormalNow(), freshness()]);
  return { ...f, abnormal, freshness: fresh };
});
