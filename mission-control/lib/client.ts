'use client';

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}

export async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}

/** Poll an API route. Default 15s; pass a shorter interval for live views. */
export function useApi<T>(url: string | null, intervalMs = 15000, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({
    queryKey: [url],
    queryFn: () => getJson<T>(url as string),
    enabled: Boolean(url),
    refetchInterval: intervalMs,
    refetchOnWindowFocus: true,
    ...opts,
  });
}
