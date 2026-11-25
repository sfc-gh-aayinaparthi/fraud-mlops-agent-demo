'use client';

import { dimLabel, fmtMetric, interventionLabel, stripRefs } from '@/lib/status';
import { cn } from '@/lib/utils';
import { CheckCircle2, CircleDot, FlaskConical, XCircle } from 'lucide-react';

type Row = Record<string, any>;
const COLS: { key: string; label: string; icon: typeof CircleDot; tone: string }[] = [
  { key: 'confirmed', label: 'Confirmed cause', icon: CheckCircle2, tone: 'var(--brand)' },
  { key: 'testing', label: 'Being tested', icon: FlaskConical, tone: 'var(--agent)' },
  { key: 'proposed', label: 'Not tested yet', icon: CircleDot, tone: 'var(--muted-foreground)' },
  { key: 'ruled_out', label: 'Ruled out', icon: XCircle, tone: 'var(--muted-foreground)' },
];

/** The agent's possible causes, by their latest status. Empty groups are hidden. */
export function HypothesisBoard({ hypotheses, entities }: { hypotheses: Row[]; entities: Row[] }) {
  if (!hypotheses.length) return <p className="text-sm text-muted-foreground">The agent hasn&rsquo;t listed possible causes yet.</p>;
  const name = (id: string) => entities.find((e) => e.entity_id === id)?.name;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">Possible causes</h3>
      <div className="space-y-3">
        {COLS.map((c) => {
          const items = hypotheses.filter((h) => h.status === c.key);
          if (!items.length) return null;
          return (
            <div key={c.key}>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: c.tone }}><c.icon className="h-3.5 w-3.5" aria-hidden />{c.label}</p>
              <ul className="space-y-1">
                {items.map((h) => (
                  <li key={h.hypothesis_id} className={cn('text-xs', c.key === 'ruled_out' && 'text-muted-foreground')}>
                    {name(h.component) && <span className="font-medium">{name(h.component)}: </span>}
                    {stripRefs(h.text)}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Names for intervention kinds, taken from the system's own components. */
export function interventionNames(entities: Row[]): Record<string, string> {
  const pick = (t: string) => entities.find((e) => e.entity_type === t)?.name;
  return { pipeline: pick('feature_pipeline') ?? 'the pipeline', model: pick('model') ?? 'the model' };
}

/** What-if tests: one line each, with the share of the problem it removes. */
export function Experiments({ experiments, entities = [], unit = 'share' }: { experiments: Row[]; entities?: Row[]; unit?: string }) {
  if (!experiments.length) return <p className="text-sm text-muted-foreground">No what-if tests run yet.</p>;
  const names = interventionNames(entities);
  return (
    <ul className="space-y-2">
      {experiments.map((x, i) => {
        const pct = Math.max(0, Math.min(100, Math.round(Number(x.explained_pct))));
        return (
          <li key={i} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm">{interventionLabel(x.intervention, names)}</p>
              <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', x.pass ? 'bg-brand/15 text-brand' : 'bg-muted text-muted-foreground')}>
                {x.pass ? 'This is the cause' : 'Not the cause'}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-2 text-[11px]">
              <div className="h-2 rounded bg-muted"><div className="animate-grow-x h-full rounded" style={{ width: `${pct}%`, background: x.pass ? 'var(--brand)' : 'var(--muted-foreground)' }} /></div>
              <span className="tabular text-muted-foreground">fixes {pct}% of the problem</span>
            </div>
            {[x.actual, x.counterfactual, x.baseline].every((v) => Number.isFinite(Number(v))) && (
              <p className="tabular mt-1.5 text-[11px] text-muted-foreground">
                {x.metric ? dimLabel(x.metric) : 'Result'}: {fmtMetric(x.actual, unit)} actual → {fmtMetric(x.counterfactual, unit)} with this undone · normally {fmtMetric(x.baseline, unit)}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
