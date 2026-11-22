import { asUser, handle, identity } from '@/lib/api';

export const dynamic = 'force-dynamic';

const READ_ONLY = /^\s*(select|with)\b/i;
const FORBIDDEN = /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|call|execute|copy|put|remove|use)\b/i;

/**
 * Ad-hoc, read-only exploration for engineers, run with the viewer's own
 * privileges (caller's rights). Single SELECT/WITH statements only.
 */
export const POST = handle(async (req: Request) => {
  const { sql } = (await req.json()) as { sql?: string };
  const text = (sql ?? '').trim().replace(/;\s*$/, '');
  if (!READ_ONLY.test(text) || text.includes(';') || FORBIDDEN.test(text.replace(/'[^']*'/g, ''))) {
    throw new Error('Explore runs a single read-only SELECT/WITH statement');
  }
  const rows = await asUser(`SELECT * FROM (${text}) LIMIT 500`);
  return { rows, identity: identity() };
});
