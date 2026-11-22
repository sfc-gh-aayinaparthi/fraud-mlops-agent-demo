'use client';

import { Experiments, HypothesisBoard } from '@/components/incident/hypotheses';
import { Proposals } from '@/components/incident/proposals';
import { ErrorState, VerdictBadge } from '@/components/status';
import type { TwinEntity } from '@/components/twin/twin';
import { postJson, useApi } from '@/lib/client';
import type { Status } from '@/lib/status';
import { hhmmss, minutesBetween, ms } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Beaker, CircleDot, FileText, Flag, Lightbulb, Pause, Play, Radio, Send, Wrench } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

const Twin = dynamic(() => import('@/components/twin/twin'), { ssr: false, loading: () => <div className="h-[340px] animate-pulse rounded-xl bg-twin" /> });

type Row = Record<string, any>;
type RunData = { run: Row | null; events: Row[]; proposals: Row[]; entities: Row[]; edges: Row[] };

const KIND = {
  run_start: { icon: Radio, label: 'Run started' }, step: { icon: CircleDot, label: 'Step' }, tool: { icon: Wrench, label: 'Tool' },
  hypothesis: { icon: Lightbulb, label: 'Hypothesis' }, experiment: { icon: Beaker, label: 'Experiment' }, proposal: { icon: Send, label: 'Proposal' },
  report: { icon: FileText, label: 'Report' }, run_end: { icon: Flag, label: 'Run ended' },
} as Record<string, { icon: typeof Radio; label: string }>;

function summary(e: Row): string {
  const a = e.attributes ?? {};
  switch (e.kind) {
    case 'tool': return a.result_summary ?? a.query ?? '';
    case 'step': return a.summary ?? '';
    case 'hypothesis': return `${a.id}: ${a.text}`;
    case 'experiment': return `${a.intervention} → explains ${Number(a.explained_pct).toFixed(0)}% (${a.pass ? 'pass' : 'fail'})`;
    case 'proposal': return `${a.action_type}${a.params?.pr_number ? ` #${a.params.pr_number}` : ''}: ${a.rationale ?? ''}`;
    case 'report': return a.subject ?? a.summary ?? '';
    case 'run_end': return a.status_line ?? a.verdict ?? '';
    case 'run_start': return `trigger: ${a.trigger ?? 'unknown'}`;
    default: return '';
  }
}

function RunInner() {
  const { runId } = useParams<{ runId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { data, error, isPending } = useApi<RunData>(`/api/agents/runs/${encodeURIComponent(runId)}`, 4000);
  const events = data?.events ?? [];
  const run = data?.run;
  const isLive = Boolean(run && !run.ended_at && (ms(run.now_ts) - ms(run.last_event_at)) / 60000 < 10);
  const initial = search.get('at');
  const [idx, setIdx] = useState<number | null>(initial ? Number(initial) : null);
  const [playing, setPlaying] = useState(false);
  const follow = idx === null;               // follow the latest event (live / default)
  const cur = follow ? events.length - 1 : Math.min(idx!, events.length - 1);
  const listRef = useRef<HTMLOListElement>(null);

  // live: pull fresh trace lines from the agent workspace
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => postJson('/api/agents/refresh', {}).catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [isLive]);

  // replay
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setIdx((i) => {
      const n = (i ?? -1) + 1;
      if (n >= events.length - 1) { setPlaying(false); return null; }
      return n;
    }), 900);
    return () => clearInterval(t);
  }, [playing, events.length]);

  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-i="${cur}"]`);
    if (list && el) list.scrollTo({ top: el.offsetTop - list.clientHeight / 2, behavior: 'smooth' });
    if (!follow) {
      const p = new URLSearchParams(search.toString()); p.set('at', String(cur));
      router.replace(`?${p.toString()}`, { scroll: false });
    }
  }, [cur, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const upto = events.slice(0, cur + 1);
  const probe = [...upto].reverse().find((e) => e.entity_id)?.entity_id ?? null;
  const hyps = useMemo(() => {
    const m = new Map<string, Row>();
    upto.filter((e) => e.kind === 'hypothesis').forEach((e) => m.set(e.attributes?.id, { hypothesis_id: e.attributes?.id, text: e.attributes?.text, component: e.attributes?.component, status: e.status }));
    return [...m.values()];
  }, [upto]);
  const exps = upto.filter((e) => e.kind === 'experiment').map((e) => ({ ...e.attributes }));
  const twinEntities = useMemo<TwinEntity[]>(() => (data?.entities ?? []).map((e) => ({ ...e, status: e.status as Status })) as TwinEntity[], [data?.entities]);

  if (error) return <ErrorState error={error} />;
  if (isPending || !data) return <div className="h-[70vh] animate-pulse rounded-xl bg-muted/40" />;
  if (!run) return <ErrorState error={new Error('This run does not exist or not authorized')} />;
  const curEv = events[cur];

  return (
    <div className="space-y-6">
      <header className="animate-rise">
        <p className="text-sm text-muted-foreground"><Link href="/agents" className="hover:text-foreground">Agents</Link> / {run.name} / <span className="font-mono">{runId}</span></p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {isLive ? <span className="flex items-center gap-1.5 rounded-full bg-agent/15 px-2 py-0.5 text-xs font-medium text-agent"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-agent" />Live</span>
            : <VerdictBadge verdict={run.verdict} />}
          <span className="text-xs text-muted-foreground">{hhmmss(run.started_at)} · {minutesBetween(run.started_at, run.ended_at ?? run.last_event_at)} min · {events.length} events · trigger {run.trigger_type ?? '—'}</span>
          {run.incident_id && <Link href={`/incidents/${run.incident_id}`} className="text-xs text-brand hover:underline">Open incident</Link>}
        </div>
        <h1 className="mt-2 max-w-5xl text-3xl font-semibold leading-tight">{run.status_line ?? (isLive ? `Investigating: ${curEv ? summary(curEv) : 'starting'}` : 'Run in progress')}</h1>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <div className="grid-texture relative overflow-hidden rounded-xl border border-border bg-twin">
            <Twin entities={twinEntities} edges={data.edges as never} volume={60} flagShare={0.01} probeEntity={probe} height={340} compact />
            <p className="pointer-events-none absolute left-3 top-3 rounded-md bg-background/80 px-2.5 py-1 text-xs backdrop-blur">
              <span className="text-agent">Probe</span> · {data.entities.find((e) => e.entity_id === probe)?.name ?? 'no component yet'}
              <span className="text-muted-foreground"> · health shown is current, not historical</span>
            </p>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <button aria-label={playing ? 'Pause replay' : 'Replay from start'} className="grid h-8 w-8 place-items-center rounded-full bg-agent text-white"
              onClick={() => { if (playing) setPlaying(false); else { setIdx(0); setPlaying(true); } }}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <label htmlFor="scrub" className="sr-only">Event position</label>
            <input id="scrub" type="range" min={0} max={Math.max(0, events.length - 1)} value={Math.max(0, cur)} className="flex-1 accent-[var(--agent)]"
              onChange={(e) => { setPlaying(false); const v = Number(e.target.value); setIdx(v >= events.length - 1 ? null : v); }} />
            <span className="tabular w-20 text-right text-xs text-muted-foreground">{cur + 1} / {events.length}</span>
            {!follow && <button className="text-xs text-agent hover:underline" onClick={() => { setPlaying(false); setIdx(null); }}>{isLive ? 'Follow live' : 'Jump to end'}</button>}
          </div>

          <ol ref={listRef} className="relative max-h-[520px] space-y-1 overflow-y-auto rounded-xl border border-border bg-card p-2" aria-label="Agent events">
            {events.map((e, i) => {
              const K = KIND[e.kind] ?? KIND.step;
              return (
                <li key={e.seq} data-i={i}>
                  <button onClick={() => { setPlaying(false); setIdx(i >= events.length - 1 ? null : i); }}
                    className={cn('grid w-full grid-cols-[4.5rem_1.25rem_1fr] items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent/60',
                      i === cur && 'bg-agent/10 ring-1 ring-agent/40', i > cur && 'opacity-40')}>
                    <span className="tabular pt-0.5 text-[11px] text-muted-foreground">{hhmmss(e.ts)}</span>
                    <K.icon className={cn('mt-0.5 h-4 w-4', e.kind === 'experiment' || e.kind === 'hypothesis' ? 'text-agent' : 'text-muted-foreground')} aria-hidden />
                    <span className="min-w-0">
                      <span className="font-medium">{e.kind === 'tool' || e.kind === 'step' ? e.name : K.label}</span>
                      {e.status && e.kind !== 'tool' && <span className="ml-1.5 text-[11px] text-muted-foreground">{String(e.status).replaceAll('_', ' ')}</span>}
                      <span className="block truncate text-xs text-muted-foreground" title={summary(e)}>{summary(e)}</span>
                      {i === cur && e.kind === 'tool' && e.attributes?.query && (
                        <code className="mt-1 block whitespace-pre-wrap rounded bg-muted px-2 py-1 font-mono text-[11px] text-foreground">{e.attributes.query}</code>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
            {isLive && <li className="px-2.5 py-2 text-xs text-agent">Waiting for the next event…</li>}
          </ol>
        </div>

        <div className="min-w-0 space-y-6">
          <section className="rounded-xl border border-agent/30 bg-card p-5" aria-label="Hypotheses">
            <h2 className="mb-3 text-base font-semibold">Hypotheses at this point</h2>
            <HypothesisBoard hypotheses={hyps} entities={data.entities} />
          </section>
          <section className="rounded-xl border border-border bg-card p-5" aria-label="Experiments">
            <h2 className="mb-3 text-base font-semibold">Counterfactual experiments</h2>
            <Experiments experiments={exps} />
          </section>
          <section className="rounded-xl border border-border bg-card p-5" aria-label="Proposals">
            <h2 className="mb-3 text-base font-semibold">Proposed actions</h2>
            <Proposals proposals={data.proposals} />
          </section>
          <section className="rounded-xl border border-border bg-card p-5 text-sm" aria-label="Guardrails">
            <h2 className="mb-2 text-base font-semibold">Guardrails for this run</h2>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li>Session scope <span className="font-mono text-foreground">{run.restricted_scope}</span>: read-only data access plus one counterfactual procedure.</li>
              <li>{events.filter((e) => e.kind === 'tool').length} tool calls recorded; every SQL statement is in query history under the agent&apos;s session.</li>
              <li>Production changes only by pull request; merges and rollbacks wait for MLOPS_APPROVER.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function RunPage() {
  return <Suspense><RunInner /></Suspense>;
}
