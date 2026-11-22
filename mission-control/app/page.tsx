'use client';

import { EmptyState, ErrorState, StatusPill, VerdictBadge } from '@/components/status';
import { useApi } from '@/lib/client';
import { fmtMetric, type Status } from '@/lib/status';
import { ago, dayTime } from '@/lib/time';
import { ArrowRight, Bot } from 'lucide-react';
import Link from 'next/link';

type Row = Record<string, any>;
type Fleet = {
  systems: Row[]; health: Row[]; incidents: Row[]; runs: Row[]; coverage: Row[]; abnormal: Row[];
  freshness: { now_ts: string };
};

function systemStatus(health: Row[], id: string): Status {
  const h = health.filter((r) => r.system_id === id);
  if (h.some((r) => r.status === 'critical' && r.n > 0)) return 'critical';
  if (h.some((r) => r.status === 'warning' && r.n > 0)) return 'warning';
  return h.length ? 'healthy' : 'unknown';
}

export default function FleetPage() {
  const { data, error, isPending } = useApi<Fleet>('/api/fleet', 15000);
  if (error) return <ErrorState error={error} />;
  if (isPending || !data) return <div className="h-[60vh] animate-pulse rounded-xl bg-muted/40" />;
  const now = data.freshness.now_ts;
  const open = data.incidents.filter((i) => i.status === 'open');
  const unexplained = data.abnormal.filter((a) => a.agent_verdict !== 'confirmed');
  const headline = open.length
    ? `${open.length} open incident${open.length > 1 ? 's' : ''} across ${new Set(open.map((i) => i.system_id)).size} system${open.length > 1 ? 's' : ''}`
    : unexplained.length
      ? `${unexplained.length} abnormal signal${unexplained.length > 1 ? 's' : ''}, no incident yet`
      : 'All monitored systems are within their expected ranges';

  return (
    <div className="space-y-10">
      <section className="animate-rise">
        <p className="text-sm text-muted-foreground">Fleet · {data.systems.length} system{data.systems.length !== 1 && 's'} under watch</p>
        <h1 className="mt-1 max-w-4xl text-4xl font-semibold leading-tight md:text-5xl">{headline}</h1>
      </section>

      <section aria-labelledby="systems" className="animate-rise [animation-delay:80ms]">
        <h2 id="systems" className="mb-3 text-sm font-medium text-muted-foreground">Systems</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.systems.map((s) => {
            const st = systemStatus(data.health, s.system_id);
            const inc = open.find((i) => i.system_id === s.system_id);
            const run = data.runs.find((r) => r.system_id === s.system_id);
            const cov = data.coverage.find((c) => c.system_id === s.system_id);
            const counts = data.health.filter((h) => h.system_id === s.system_id);
            return (
              <Link key={s.system_id} href={`/systems/${encodeURIComponent(s.system_id)}`}
                className="group relative overflow-hidden rounded-xl border border-border bg-card p-5 transition-colors hover:border-brand/50">
                {st === 'critical' && <span className="absolute right-5 top-5 h-2.5 w-2.5 rounded-full bg-critical animate-pulse-ring" aria-hidden />}
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-xl font-semibold">{s.name}</h3>
                    <p className="mt-0.5 text-sm text-muted-foreground">{s.description}</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <StatusPill status={st} />
                  {counts.map((c) => c.status !== 'healthy' && c.n > 0 && (
                    <span key={c.status} className="text-xs text-muted-foreground">{c.n} {c.status === 'warning' ? 'degraded' : c.status}</span>
                  ))}
                </div>
                <dl className="mt-5 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Open incident</dt>
                    <dd className="mt-0.5 truncate">{inc ? <span className="text-critical">{dayTime(inc.opened_at)}</span> : 'None'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Agent last ran</dt>
                    <dd className="mt-0.5">{run ? ago(run.started_at, now) : 'Never'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Coverage gaps</dt>
                    <dd className="mt-0.5">{cov ? `${cov.entities_with_gaps} of ${cov.entities}` : '—'}</dd>
                  </div>
                </dl>
                <ArrowRight className="absolute bottom-5 right-5 h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1" aria-hidden />
              </Link>
            );
          })}
        </div>
      </section>

      <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
        <section aria-labelledby="abnormal" className="animate-rise [animation-delay:160ms]">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="abnormal" className="text-sm font-medium text-muted-foreground">Abnormal now · last 60 min</h2>
            <span className="text-xs text-muted-foreground">Unexplained first</span>
          </div>
          {data.abnormal.length === 0 ? (
            <EmptyState title="Nothing abnormal">Every metric's latest value is inside its expected range.</EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {data.abnormal.map((a) => (
                <li key={a.metric_id}>
                  <Link href={a.incident_id ? `/incidents/${a.incident_id}` : `/systems/${a.system_id}?focus=${encodeURIComponent(a.entity_id)}`}
                    className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/50">
                    <span className="h-8 w-1 rounded-full" style={{ background: a.severity >= 3 ? 'var(--critical)' : 'var(--warning)' }} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{a.metric_name}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.entity_name} · {a.golden_class.replace('_', ' ')} · {ago(a.ts, now)}</p>
                    </div>
                    <div className="text-right">
                      <p className="tabular font-display text-lg leading-none">{fmtMetric(a.value, a.unit)}</p>
                      <p className="tabular mt-1 text-[11px] text-muted-foreground">
                        expected {a.expected !== null ? fmtMetric(a.expected, a.unit) : `≤ ${fmtMetric(a.expected_high, a.unit)}`}
                      </p>
                    </div>
                    <div className="hidden w-44 justify-end sm:flex">
                      {a.agent_verdict === 'confirmed' ? <VerdictBadge verdict="confirmed" /> :
                        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">Unexplained</span>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="runs" className="animate-rise [animation-delay:220ms]">
          <h2 id="runs" className="mb-3 text-sm font-medium text-muted-foreground">Latest agent activity</h2>
          {data.runs.length === 0 ? (
            <EmptyState title="No agent runs yet" />
          ) : (
            <ul className="space-y-3">
              {data.runs.map((r) => (
                <li key={r.run_id}>
                  <Link href={`/agents/runs/${encodeURIComponent(r.run_id)}`}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-agent/50">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-agent/15 text-agent"><Bot className="h-4 w-4" aria-hidden /></span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{r.agent_name}</p>
                      <p className="truncate text-xs text-muted-foreground">{r.status_line ?? (r.ended_at ? 'Finished' : 'Running…')}</p>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <VerdictBadge verdict={r.verdict} />
                      <p className="mt-1">{ago(r.started_at, now)}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
