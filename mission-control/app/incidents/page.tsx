'use client';

import { EmptyState, ErrorState, VerdictBadge } from '@/components/status';
import { useApi } from '@/lib/client';
import { dayTime, ms } from '@/lib/time';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

type Row = Record<string, any>;

function IncidentsInner() {
  const search = useSearchParams();
  const router = useRouter();
  const filter = search.get('status') ?? 'all';
  const { data, error, isPending } = useApi<{ rows: Row[] }>('/api/incidents?limit=100', 20000);
  if (error) return <ErrorState error={error} />;
  const rows = (data?.rows ?? []).filter((r) => filter === 'all' || r.status === filter);
  const open = (data?.rows ?? []).filter((r) => r.status === 'open').length;

  return (
    <div className="space-y-6">
      <div className="animate-rise">
        <p className="text-sm text-muted-foreground">Incidents · correlated from abnormal signals, grouped per system</p>
        <h1 className="mt-1 text-4xl font-semibold">{open ? `${open} open` : 'No open incidents'}</h1>
      </div>
      <div className="flex gap-1" role="tablist" aria-label="Filter incidents">
        {['all', 'open', 'resolved'].map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => router.replace(`?status=${f}`)}
            className={cn('rounded-md px-3 py-1.5 text-sm capitalize text-muted-foreground hover:bg-accent', filter === f && 'bg-accent text-foreground')}>
            {f}
          </button>
        ))}
      </div>
      {isPending ? <div className="h-64 animate-pulse rounded-xl bg-muted/40" /> : rows.length === 0 ? (
        <EmptyState title="Nothing here">Incidents open automatically when signals leave their expected range.</EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((r) => {
            const dur = Math.round(((r.resolved_at ? ms(r.resolved_at) : ms(r.last_signal_at)) - ms(r.opened_at)) / 60000);
            return (
              <li key={r.incident_id}>
                <Link href={`/incidents/${r.incident_id}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3.5 hover:bg-accent/50 md:grid-cols-[auto_1fr_10rem_12rem_10rem]">
                  <span className={cn('h-2.5 w-2.5 rounded-full', r.status === 'open' ? 'bg-critical animate-pulse-ring' : 'bg-muted-foreground/40')} aria-label={r.status} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.title}</p>
                    <p className="text-xs text-muted-foreground">{r.system_name} · severity {Number(r.severity).toFixed(1)}</p>
                  </div>
                  <p className="tabular hidden text-sm md:block">{dayTime(r.opened_at)}</p>
                  <p className="tabular hidden text-sm text-muted-foreground md:block">{r.status === 'open' ? `open ${dur} min` : `lasted ${dur} min`}</p>
                  <div className="flex justify-end"><VerdictBadge verdict={r.agent_verdict} /></div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function IncidentsPage() {
  return <Suspense><IncidentsInner /></Suspense>;
}
