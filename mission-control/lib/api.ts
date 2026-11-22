import { callersRightsActive } from '@/lib/run-as';
import { asCaller, snowflake } from '@/lib/snowflake';

type Row = Record<string, unknown>;

/** JSON route wrapper with a consistent error shape. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      return Response.json(await fn(...args));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[api]', msg);
      const status = /insufficient privileges|not authorized|does not exist or not authorized/i.test(msg) ? 403 : 500;
      return Response.json({ error: msg.slice(0, 400) }, { status });
    }
  };
}

/**
 * Run a statement as the signed-in user (caller's rights) so actions are
 * authorised and audited per person. In local dev this uses the developer's
 * connection (identity "dev").
 */
export async function asUser(sql: string, binds: unknown[] = []) {
  const client = callersRightsActive() ? await asCaller() : snowflake;
  const { rows } = await client.query(sql, { binds: binds as never });
  return (rows as Row[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
}

export function identity(): 'caller' | 'dev' {
  return callersRightsActive() ? 'caller' : 'dev';
}
