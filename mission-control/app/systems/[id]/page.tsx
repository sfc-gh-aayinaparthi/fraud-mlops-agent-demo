'use client';

import { SignalChart, type SignalPoint } from '@/components/signal-chart';
import { ErrorState, StatusPill, VerdictBadge } from '@/components/status';
import type { TwinEntity } from '@/components/twin/twin';
import { postJson, useApi } from '@/lib/client';
import { fmtMetric, STAGE_LABEL, type Status } from '@/lib/status';
import { ago, hhmm, ms } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Bot, Siren, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo } from 'react';

const Twin = dynamic(() => import('@/components/twin/twin'), {
  ssr: false,
  loading: () => <div className="h-[520px] animate-pulse rounded-xl bg-twin" />,
});

type Row = Record<string, any>;
type SystemData = {
  system: Row; entities: Row[]; edges: Row[]; incidents: Row[]; agents: Row[]; deploys: Row[]; kpis: Row[];
  freshness: { now_ts: string; signals_at: string };
};

/** A run is live if it has no run_end and emitted an event in the last 10 minutes. */
function useLiveRun(systemId: string, now?: string) {
  const runs = useApi<{ runs: Row[] }>('/api/agents', 8000);
  const live = runs.data?.runs.find((r) => r.system_id === systemId && !r.ended_at && now &&
    (ms(now) - ms(r.last_event_at)) / 60000 < 10);
  const events = useApi<{ events: Row[] }>(live ? `/api/agents/runs/${encodeURIComponent(live.run_id)}` : null, 4000);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => postJson('/api/agents/refresh', {}).catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [live]);
  const last = [...(events.data?.events ?? [])].reverse().find((e) => e.entity_id);
  const lastStep = [...(events.data?.events ?? [])].reverse().find((e) => e.kind === 'step' || e.kind === 'tool');
  return { live, probe: (last?.entity_id as string) ?? null, lastStep };
}

function SystemInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const selected = search.get('focus');
  const { data, error, isPending } = useApi<SystemData>(`/api/systems/${encodeURIComponent(id)}`, 15000);
  const { live, probe, lastStep } = useLiveRun(id, data?.freshness.now_ts);

  const select = (eid: string | null) => {
    const p = new URLSearchParams(search.toString());
    if (eid) p.set('focus', eid); else p.delete('focus');
    router.replace(`?${p.toString()}`, { scroll: false });
  };

  const twinEntities = useMemo<TwinEntity[]>(
    () => (data?.entities ?? []).map((e) => ({ entity_id: e.entity_id, name: e.name, stage: e.stage, entity_type: e.entity_type, status: e.status as Status })),
    [data?.entities],
  );

  if (error) return <ErrorState error={error} />;
  if (isPending || !data) return <div className="h-[70vh] animate-pulse rounded-xl bg-muted/40" />;

  const now = data.freshness.now_ts;
  const open = data.incidents.find((i) => i.status === 'open');
  const volume = Number(data.kpis.find((k) => k.golden_class === 'volume')?.value ?? 60);
  const flagShare = Number(data.kpis.find((k) => k.golden_class === 'output' && k.unit === 'share')?.value ?? 0.01);
  const critical = data.entities.filter((e) => e.status === 'critical');
  const sentence = open
    ? `${critical.length ? critical.map((c) => c.name).join(', ') : 'Signals'} abnormal since ${hhmm(open.opened_at)}`
    : critical.length || data.entities.some((e) => e.status === 'warning')
      ? 'Some components are outside their expected range'
      : 'Every component is within its expected range';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 animate-rise">
        <div>
          <p className="text-sm text-muted-foreground"><Link href="/" className="hover:text-foreground">Fleet</Link> / {data.system.name}</p>
          <h1 className="mt-1 text-3xl font-semibold md:text-4xl">{sentence}</h1>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>Owner {data.system.owner}</p>
          <p>Signals evaluated {ago(data.freshness.signals_at, now)}</p>
        </div>
      </div>

      <section className="relative animate-rise [animation-delay:60ms]" aria-label="System digital twin">
        <div className="grid-texture overflow-hidden rounded-xl border border-border bg-twin">
          <Twin entities={twinEntities} edges={data.edges as never} volume={volume} flagShare={flagShare}
            probeEntity={live ? probe : null} selected={selected} onSelect={(e) => select(e)} height={540} />
        </div>

        <div className="pointer-events-none absolute left-4 top-4 flex max-w-[70%] flex-col gap-2">
          {open && (
            <Link href={`/incidents/${open.incident_id}`}
              className="pointer-events-auto flex items-center gap-3 rounded-lg border border-critical/50 bg-background/85 px-4 py-2.5 backdrop-blur transition-colors hover:border-critical">
              <Siren className="h-4 w-4 text-critical" aria-hidden />
              <div className="text-sm">
                <p className="font-medium">Incident open {ago(open.opened_at, now)}</p>
                <p className="text-xs text-muted-foreground">{open.title}</p>
              </div>
              <VerdictBadge verdict={open.agent_verdict} />
            </Link>
          )}
          {live && (
            <Link href={`/agents/runs/${encodeURIComponent(live.run_id)}`}
              className="pointer-events-auto flex items-center gap-3 rounded-lg border border-agent/50 bg-background/85 px-4 py-2.5 backdrop-blur">
              <Bot className="h-4 w-4 text-agent" aria-hidden />
              <div className="text-sm">
                <p className="font-medium text-agent">{live.agent_name ?? 'Agent'} investigating</p>
                <p className="max-w-md truncate text-xs text-muted-foreground">
                  {lastStep ? `${lastStep.name}: ${lastStep.attributes?.result_summary ?? lastStep.attributes?.summary ?? ''}` : 'Starting…'}
                </p>
              </div>
            </Link>
          )}
        </div>
        <Legend />

        {selected && <NodeDrawer entity={data.entities.find((e) => e.entity_id === selected)} kpis={data.kpis} deploys={data.deploys}
          onClose={() => select(null)} />}
      </section>

      <section aria-labelledby="signals" className="animate-rise [animation-delay:120ms]">
        <h2 id="signals" className="mb-3 text-sm font-medium text-muted-foreground">Golden signals · latest 5-minute window</h2>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3 xl:grid-cols-6">
          {data.kpis.map((k) => (
            <button key={k.metric_id} onClick={() => select(k.entity_id)}
              className={cn('bg-card p-4 text-left transition-colors hover:bg-accent/60', k.is_abnormal && 'bg-critical/5')}>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: k.is_abnormal ? 'var(--critical)' : k.value === null ? 'var(--muted-foreground)' : 'var(--brand)' }} aria-hidden />
                <span className="truncate">{k.name}</span>
              </p>
              <p className={cn('tabular mt-2 font-display text-2xl leading-none', k.is_abnormal && 'text-critical')}>{fmtMetric(k.value, k.unit)}</p>
              <p className="tabular mt-1.5 text-[11px] text-muted-foreground">
                {k.value === null ? 'No recent data' : k.expected !== null
                  ? `expected ${fmtMetric(k.expected_low, k.unit)}–${fmtMetric(k.expected_high, k.unit)}`
                  : k.expected_high !== null ? `limit ${fmtMetric(k.expected_high, k.unit)}` : `minimum ${fmtMetric(k.expected_low, k.unit)}`}
              </p>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [['var(--brand)', 'Healthy flow'], ['var(--warning)', 'Degraded'], ['var(--critical)', 'Critical / flagged'], ['var(--agent)', 'Agent probe']];
  return (
    <ul className="pointer-events-none absolute bottom-4 left-4 flex flex-wrap gap-3 rounded-lg bg-background/70 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur">
      {items.map(([c, l]) => (
        <li key={l} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{l}</li>
      ))}
    </ul>
  );
}

function NodeDrawer({ entity, kpis, deploys, onClose }: { entity?: Row; kpis: Row[]; deploys: Row[]; onClose: () => void }) {
  const metrics = kpis.filter((k) => k.entity_id === entity?.entity_id);
  const ids = metrics.map((m) => m.metric_id).join(',');
  const series = useApi<{ rows: SignalPoint[] & Row[] }>(ids ? `/api/series?metrics=${encodeURIComponent(ids)}&hours=3` : null, 30000);
  if (!entity) return null;
  const hook = deploys.find((d) => d.entity_id === entity.entity_id);
  return (
    <aside className="absolute right-3 top-3 bottom-3 z-20 flex w-[min(420px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-background/95 shadow-2xl backdrop-blur"
      aria-label={`${entity.name} details`}>
      <div className="flex items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{STAGE_LABEL[entity.stage] ?? entity.stage} · {entity.entity_type}</p>
          <h3 className="mt-0.5 text-xl font-semibold">{entity.name}</h3>
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{entity.fqn}</p>
        </div>
        <button onClick={onClose} className="rounded-md p-1 hover:bg-accent" aria-label="Close details"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusPill status={entity.status} />
          <span className="text-muted-foreground">Owner {entity.owner}</span>
          {hook && <span className="text-muted-foreground">· deploys from {hook.branch}:{hook.path}</span>}
        </div>
        {metrics.length === 0 ? (
          <p className="rounded-lg border border-dashed border-warning/50 p-3 text-sm text-warning">
            No monitors on this component. Agents can't detect problems that start here; add a metric to its catalog.
          </p>
        ) : metrics.map((m) => (
          <div key={m.metric_id}>
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium">{m.name}</p>
              <p className={cn('tabular text-sm', m.is_abnormal && 'text-critical')}>{fmtMetric(m.value, m.unit)}</p>
            </div>
            <p className="text-xs text-muted-foreground">{m.description}</p>
            <SignalChart label={m.name} unit={m.unit} height={110}
              points={(series.data?.rows ?? []).filter((r: Row) => r.metric_id === m.metric_id) as SignalPoint[]} />
          </div>
        ))}
      </div>
    </aside>
  );
}


export default function SystemPage() {
  return <Suspense><SystemInner /></Suspense>;
}
