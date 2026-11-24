'use client';

import { useApi } from '@/lib/client';
import { useCursor } from '@/lib/cursor';
import { fmtMetric } from '@/lib/status';
import { hhmm, ms } from '@/lib/time';

type Cell = { metric_id: string; name: string; golden_class: string; ts: string; value: number; intensity: number; is_abnormal: boolean };

/**
 * Every metric of the system (rows) x 5-minute buckets (columns), coloured by
 * how far each reading is from its expected value. The first column that lights
 * up is usually the first thing that broke.
 */
export function Heatmap({ incidentId, openedAt, units }: { incidentId: string; openedAt: string; units: Record<string, string> }) {
  const { data, isPending, error } = useApi<{ rows: Cell[] }>(`/api/incidents/${incidentId}/heatmap`, 60000);
  const cursor = useCursor();
  if (isPending) return <div className="h-48 animate-pulse rounded-lg bg-muted/40" />;
  if (error) return <p className="text-sm text-critical">Couldn&rsquo;t load this view: {String((error as Error).message)}</p>;
  const rows = data?.rows ?? [];
  const times = [...new Set(rows.map((r) => ms(r.ts)))].sort((a, b) => a - b);
  const metrics = [...new Map(rows.map((r) => [r.metric_id, r])).values()];
  const cell = new Map(rows.map((r) => [`${r.metric_id}|${ms(r.ts)}`, r]));
  const firstBad = new Map<string, number>();
  rows.filter((r) => r.is_abnormal).forEach((r) => { if (!firstBad.has(r.metric_id)) firstBad.set(r.metric_id, ms(r.ts)); });
  const order = [...metrics].sort((a, b) => (firstBad.get(a.metric_id) ?? Infinity) - (firstBad.get(b.metric_id) ?? Infinity));
  const opened = ms(openedAt);
  if (!times.length) return <p className="text-sm text-muted-foreground">No signal history around this incident.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-[2px] text-xs" aria-label="Signal deviation heatmap">
        <thead>
          <tr>
            <th className="sticky left-0 bg-card pr-3 text-left font-normal text-muted-foreground">Health check</th>
            {times.map((t, i) => (
              <th key={t} className="w-4 font-normal text-muted-foreground">
                {i % 6 === 0 ? <span className="tabular block -rotate-45 whitespace-nowrap text-[10px]">{hhmm(new Date(t).toISOString())}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((m) => (
            <tr key={m.metric_id}>
              <th scope="row" className="sticky left-0 max-w-[14rem] truncate bg-card pr-3 text-left font-normal">{m.name}</th>
              {times.map((t) => {
                const c = cell.get(`${m.metric_id}|${t}`);
                const k = c ? Number(c.intensity) : 0;
                const bg = !c ? 'transparent' : c.is_abnormal
                  ? `color-mix(in oklab, var(--critical) ${Math.round(35 + k * 60)}%, transparent)`
                  : `color-mix(in oklab, var(--brand) ${Math.round(8 + k * 60)}%, transparent)`;
                return (
                  <td key={t} title={c ? `${m.name} ${hhmm(c.ts)}: ${fmtMetric(c.value, units[m.metric_id])}${c.is_abnormal ? ' (outside normal)' : ''}` : 'no data'}
                    onMouseEnter={() => cursor.set(t)} onMouseLeave={() => cursor.set(null)}
                    className="h-5 min-w-3 rounded-[3px]"
                    style={{ background: bg, outline: cursor.ts === t ? '1px solid var(--foreground)' : t === opened ? '1px dashed var(--critical)' : undefined }} />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px]" style={{ background: 'color-mix(in oklab, var(--brand) 30%, transparent)' }} />Normal</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px]" style={{ background: 'color-mix(in oklab, var(--critical) 80%, transparent)' }} />Outside normal (darker = further off)</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px]" style={{ outline: '1px dashed var(--critical)' }} />Incident start</span>
      </div>
    </div>
  );
}
