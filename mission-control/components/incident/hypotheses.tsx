'use client';

import { cn } from '@/lib/utils';
import { CheckCircle2, CircleDot, FlaskConical, XCircle } from 'lucide-react';

type Row = Record<string, any>;
const COLS: { key: string; label: string; icon: typeof CircleDot; tone: string }[] = [
  { key: 'proposed', label: 'Proposed', icon: CircleDot, tone: 'var(--muted-foreground)' },
  { key: 'testing', label: 'Testing', icon: FlaskConical, tone: 'var(--agent)' },
  { key: 'ruled_out', label: 'Ruled out', icon: XCircle, tone: 'var(--muted-foreground)' },
  { key: 'confirmed', label: 'Confirmed', icon: CheckCircle2, tone: 'var(--brand)' },
];

/** The agent's hypotheses, by their latest status. */
export function HypothesisBoard({ hypotheses, entities }: { hypotheses: Row[]; entities: Row[] }) {
  if (!hypotheses.length) return <p className="text-sm text-muted-foreground">The agent has not recorded hypotheses for this incident.</p>;
  const name = (id: string) => entities.find((e) => e.entity_id === id)?.name ?? id;
  return (
    <div className="grid grid-cols-2 gap-2">
      {COLS.map((c) => {
        const items = hypotheses.filter((h) => h.status === c.key);
        return (
          <div key={c.key} className="rounded-lg bg-muted/40 p-2">
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: c.tone }}><c.icon className="h-3.5 w-3.5" aria-hidden />{c.label} · {items.length}</p>
            <ul className="space-y-1.5">
              {items.map((h) => (
                <li key={h.hypothesis_id} className={cn('rounded-md border border-border bg-card p-2 text-xs', c.key === 'ruled_out' && 'opacity-60')}>
                  <p className={cn(c.key === 'ruled_out' && 'line-through decoration-muted-foreground/60')}>{h.text}</p>
                  {h.component && <p className="mt-1 text-[10px] text-muted-foreground">{name(h.component)}</p>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Counterfactual experiments: actual vs counterfactual vs baseline, with the pass rule. */
export function Experiments({ experiments }: { experiments: Row[] }) {
  if (!experiments.length) return <p className="text-sm text-muted-foreground">No experiments run.</p>;
  return (
    <ul className="space-y-3">
      {experiments.map((x, i) => {
        const vals = [Number(x.actual), Number(x.counterfactual), Number(x.baseline)].filter(Number.isFinite);
        const max = Math.max(...vals, 1e-9);
        const bar = (v: number, color: string, label: string) => (
          <div className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-2 text-[11px]">
            <span className="text-muted-foreground">{label}</span>
            <div className="h-2.5 rounded bg-muted"><div className="animate-grow-x h-full rounded" style={{ width: `${(v / max) * 100}%`, background: color }} /></div>
            <span className="tabular text-right">{(v * 100).toFixed(2)}%</span>
          </div>
        );
        return (
          <li key={i} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <p className="text-sm font-medium">Revert <span className="font-mono text-xs">{x.intervention}</span></p>
              <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', x.pass ? 'bg-brand/15 text-brand' : 'bg-warning/15 text-warning')}>
                {x.pass ? 'Confirms' : 'Does not confirm'}
              </span>
            </div>
            <div className="space-y-1">
              {Number.isFinite(Number(x.actual)) && bar(Number(x.actual), 'var(--critical)', 'Actual')}
              {Number.isFinite(Number(x.counterfactual)) && bar(Number(x.counterfactual), 'var(--agent)', 'Counterfactual')}
              {Number.isFinite(Number(x.baseline)) && bar(Number(x.baseline), 'var(--brand)', 'Baseline')}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Explains <span className="tabular font-medium text-foreground">{Number(x.explained_pct).toFixed(0)}%</span> of the excess
              {x.rule && <> · rule: {x.rule}</>}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
