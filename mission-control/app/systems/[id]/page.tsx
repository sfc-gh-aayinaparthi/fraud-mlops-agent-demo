'use client';

import { SignalChart, type SignalPoint } from '@/components/signal-chart';
import { ErrorState, StatusPill, VerdictBadge } from '@/components/status';
import { TwinLegend, type TwinEntity } from '@/components/twin/twin';
import { postJson, useApi } from '@/lib/client';
import { fmtMetric, normalRange, plural, stepLabel, type Status } from '@/lib/status';
import { ago, hhmm, ms } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Bot, Siren, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

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
    () => (data?.entities ?? []).map((e) => ({ entity_id: e.entity_id, name: e.name, stage: e.stage, entity_type: e.entity_type, status: e.status as Status, subtitle: e.subtitle })),
    [data?.entities],
  );

  if (error) return <ErrorState error={error} />;
  if (isPending || !data) return <div className="h-[70vh] animate-pulse rounded-xl bg-muted/40" />;

  const now = data.freshness.now_ts;
  const open = data.incidents.find((i) => i.status === 'open');
  const volume = Number(data.kpis.find((k) => k.golden_class === 'volume')?.value ?? 60);
  const flagShare = Number(data.kpis.find((k) => k.golden_class === 'output' && k.unit === 'share')?.value ?? 0.01);
  const critical = data.entities.filter((e) => e.status === 'critical');
  const degraded = data.entities.filter((e) => e.status === 'warning');
  const names = (xs: Row[]) => xs.map((c) => c.name).join(', ');
  const sentence = open
    ? `Problem in ${critical.length ? names(critical) : 'this system'} since ${hhmm(open.opened_at)}`
    : critical.length
      ? `Problem in ${names(critical)}`
      : degraded.length
        ? `${names(degraded)} ${degraded.length === 1 ? 'is' : 'are'} slightly outside normal`
        : 'Everything is running normally';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 animate-rise">
        <div>
          <p className="text-sm text-muted-foreground"><Link href="/" className="hover:text-foreground">Fleet</Link> / {data.system.name}</p>
          <h1 className="mt-1 text-3xl font-semibold md:text-4xl">{sentence}</h1>
        </div>
        <p className="text-right text-xs text-muted-foreground">Owner {data.system.owner}</p>
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
                <p className="font-medium">Incident opened {ago(open.opened_at, now)}</p>
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
                <p className="font-medium text-agent">{live.agent_name ?? 'Agent'} is investigating</p>
                <p className="max-w-md truncate text-xs text-muted-foreground">
                  {lastStep ? stepLabel(lastStep.name) : 'Starting…'}
                </p>
              </div>
            </Link>
          )}
        </div>

        <TwinLegend className="mt-2 px-1 text-[11px] text-muted-foreground" />
        {selected && <NodeDrawer entity={data.entities.find((e) => e.entity_id === selected)} kpis={data.kpis} deploys={data.deploys}
          onClose={() => select(null)} />}
      </section>

      <HealthChecks kpis={data.kpis} entities={data.entities} onSelect={select} />
    </div>
  );
}

function HealthChecks({ kpis, entities, onSelect }: { kpis: Row[]; entities: Row[]; onSelect: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const bad = kpis.filter((k) => k.is_abnormal);
  const ok = kpis.filter((k) => !k.is_abnormal);
  const shown = all ? [...bad, ...ok] : bad;
  const name = (id: string) => entities.find((e) => e.entity_id === id)?.name ?? '';
  return (
    <section aria-labelledby="checks" className="animate-rise [animation-delay:120ms]">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="checks" className="text-sm font-medium text-muted-foreground">
          Health checks · {bad.length ? `${plural(bad.length, 'problem')}, ` : ''}{ok.length} normal · latest 5 minutes
        </h2>
        {ok.length > 0 && (
          <button onClick={() => setAll(!all)} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {all ? 'Show problems only' : `Show all ${kpis.length}`}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">All {kpis.length} health checks are normal.</p>
      ) : (
        <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
          {shown.map((k) => (
            <button key={k.metric_id} onClick={() => onSelect(k.entity_id)} title="Open this component"
              className={cn('group bg-card p-4 text-left transition-colors hover:bg-accent/60', k.is_abnormal && 'bg-critical/5')}>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{name(k.entity_id)}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-sm">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: k.is_abnormal ? 'var(--critical)' : k.value === null ? 'var(--muted-foreground)' : 'var(--brand)' }} aria-hidden />
                <span className="truncate">{k.name}</span>
              </p>
              <p className={cn('tabular mt-2 font-display text-2xl leading-none', k.is_abnormal && 'text-critical')}>{fmtMetric(k.value, k.unit)}</p>
              <p className="tabular mt-1.5 flex justify-between text-[11px] text-muted-foreground">
                <span>{k.value === null ? 'No recent data' : normalRange(k)}</span>
                <span className="opacity-0 transition-opacity group-hover:opacity-100">Details ›</span>
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
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
          <h3 className="text-xl font-semibold">{entity.name}</h3>
          {entity.subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{entity.subtitle}</p>}
        </div>
        <button onClick={onClose} className="rounded-md p-1 hover:bg-accent" aria-label="Close details"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusPill status={entity.status} />
          <span className="text-muted-foreground">Owner {entity.owner}</span>
          {hook && <span className="text-muted-foreground">· fixes deploy automatically</span>}
        </div>
        {metrics.length === 0 ? (
          <p className="rounded-lg border border-dashed border-warning/50 p-3 text-sm text-warning">
            No health checks here, so problems that start in this component won\u2019t be detected.
          </p>
        ) : metrics.map((m) => (
          <div key={m.metric_id}>
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium">{m.name}</p>
              <p className={cn('tabular text-sm', m.is_abnormal && 'text-critical')}>{fmtMetric(m.value, m.unit)}</p>
            </div>
            <p className="text-xs text-muted-foreground">{m.description} · {normalRange(m)} · last 3 hours</p>
            <SignalChart label={m.name} unit={m.unit} height={110}
              points={(series.data?.rows ?? []).filter((r: Row) => r.metric_id === m.metric_id) as SignalPoint[]} />
          </div>
        ))}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Technical details</summary>
          <dl className="mt-2 space-y-1 break-all font-mono text-[11px]">
            <div>{entity.fqn}</div>
            {hook && <div>deploys from {hook.branch}:{hook.path}</div>}
          </dl>
        </details>
      </div>
    </aside>
  );
}


export default function SystemPage() {
  return <Suspense><SystemInner /></Suspense>;
}
