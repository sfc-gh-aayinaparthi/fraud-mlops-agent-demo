'use client';

import { useApi } from '@/lib/client';

type Slice = { dimension: string; dim_value: string; n: number; rate: number; baseline_rate: number | null; excess: number; share_of_excess: number | null };

/**
 * Where is the excess concentrated? For each configured dimension, the value
 * carrying the largest share of the excess outcome vs the same hours last week.
 */
export function Slices({ incidentId }: { incidentId: string }) {
  const { data, isPending, error } = useApi<{ rows: Slice[]; configured: boolean; outcome?: string }>(`/api/incidents/${incidentId}/slices`, 0, { staleTime: 300000 });
  if (isPending) return <div className="h-40 animate-pulse rounded-lg bg-muted/40" />;
  if (error) return <p className="text-sm text-critical">Slice analysis failed: {(error as Error).message}</p>;
  if (!data?.configured) return <p className="text-sm text-muted-foreground">No slice configuration for this system. Add a row to SLICE_CONFIG to enable it.</p>;
  const rows = data.rows.map((r) => ({ ...r, share_of_excess: Number(r.share_of_excess ?? 0), rate: Number(r.rate), baseline_rate: r.baseline_rate === null ? null : Number(r.baseline_rate), n: Number(r.n) }));
  // traffic share per value, so we rank by concentration (excess share beyond traffic share)
  const totals = new Map<string, number>();
  rows.forEach((r) => totals.set(r.dimension, (totals.get(r.dimension) ?? 0) + r.n));
  const scored = rows.map((r) => ({ ...r, traffic: r.n / (totals.get(r.dimension) || 1) })).map((r) => ({ ...r, lift: r.share_of_excess - r.traffic }));
  const best = new Map<string, (typeof scored)[number]>();
  scored.forEach((r) => { const b = best.get(r.dimension); if (!b || r.lift > b.lift) best.set(r.dimension, r); });
  const top = [...best.values()].filter((r) => r.lift > 0.1 && r.traffic < 0.95).sort((a, b) => b.lift - a.lift);
  if (!top.length) return <p className="text-sm text-muted-foreground">The excess is spread in proportion to traffic; no single slice explains it.</p>;
  const lead = top[0];
  return (
    <div>
      <p className="mb-4 text-sm">
        <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-xs">{lead.dimension} = {lead.dim_value}</span> carries{' '}
        <span className="font-medium">{Math.round(lead.share_of_excess * 100)}% of the excess {data.outcome}</span> from {Math.round(lead.traffic * 100)}% of traffic
      </p>
      <p className="mb-3 text-[11px] text-muted-foreground">Bar = share of excess · tick = share of traffic · ranked by how much the excess exceeds traffic</p>
      <ul className="space-y-2.5">
        {top.slice(0, 7).map((r) => (
          <li key={r.dimension} className="grid grid-cols-[9rem_1fr_6.5rem] items-center gap-3 text-xs">
            <span className="truncate text-muted-foreground" title={r.dimension}>{r.dimension.replaceAll('_', ' ')}</span>
            <div className="relative h-6 overflow-hidden rounded bg-muted">
              <div className="animate-grow-x absolute inset-y-0 left-0 rounded" style={{ width: `${Math.min(100, r.share_of_excess * 100)}%`, background: 'color-mix(in oklab, var(--critical) 55%, transparent)' }} />
              <div className="absolute inset-y-0 w-0.5 bg-foreground/70" style={{ left: `${Math.min(100, r.traffic * 100)}%` }} title={`${Math.round(r.traffic * 100)}% of traffic`} />
              <span className="absolute inset-0 flex items-center px-2 font-mono text-[11px] text-foreground">{r.dim_value}</span>
            </div>
            <span className="tabular text-right">
              {Math.round(r.share_of_excess * 100)}%
              <span className="block text-[10px] text-muted-foreground">{(r.rate * 100).toFixed(1)}% vs {r.baseline_rate === null ? 'new' : `${(r.baseline_rate * 100).toFixed(1)}%`}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
