'use client';

import { Experiments, HypothesisBoard } from '@/components/incident/hypotheses';
import { Explore } from '@/components/incident/explore';
import { Heatmap } from '@/components/incident/heatmap';
import { Proposals } from '@/components/incident/proposals';
import { Slices } from '@/components/incident/slices';
import { SignalChart, type Marker, type SignalPoint } from '@/components/signal-chart';
import { ErrorState, VerdictBadge } from '@/components/status';
import { postJson, useApi } from '@/lib/client';
import { fmtMetric } from '@/lib/status';
import { dayTime, hhmm, minutesBetween, ntz } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, GitCommitHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type React from 'react';
import { useState } from 'react';

type Row = Record<string, any>;
type Detail = {
  incident: Row; signals: Row[]; metrics: Row[]; changes: Row[]; hypotheses: Row[]; experiments: Row[];
  proposals: Row[]; runs: Row[]; entities: Row[];
};

function Section({ title, children, aside, className }: { title: string; children: React.ReactNode; aside?: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-border bg-card p-5', className)} aria-label={title}>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export default function IncidentPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isPending } = useApi<Detail>(`/api/incidents/${id}`, 15000);
  const inc = data?.incident;
  const signalIds = (data?.signals ?? []).map((s) => s.metric_id);
  const series = useApi<{ rows: Row[] }>(
    inc && signalIds.length ? `/api/series?metrics=${encodeURIComponent(signalIds.join(','))}&hours=2&around=${encodeURIComponent(ntz(inc.opened_at))}` : null,
    30000,
  );
  if (error) return <ErrorState error={error} />;
  if (isPending || !data || !inc) return <div className="h-[70vh] animate-pulse rounded-xl bg-muted/40" />;

  const metric = (mid: string) => data.metrics.find((m) => m.metric_id === mid);
  const units = Object.fromEntries(data.metrics.map((m) => [m.metric_id, m.unit]));
  // lead signal: output metrics first, then severity
  const lead = [...data.signals].sort((a, b) =>
    (metric(b.metric_id)?.golden_class === 'output' ? 1 : 0) - (metric(a.metric_id)?.golden_class === 'output' ? 1 : 0) || Number(b.max_severity) - Number(a.max_severity))[0];
  const pts = (mid: string) => (series.data?.rows ?? []).filter((r) => r.metric_id === mid) as SignalPoint[];
  const leadPts = lead ? pts(lead.metric_id) : [];
  const peak = leadPts.filter((p) => p.is_abnormal).sort((a, b) => Number(b.value) - Number(a.value))[0];
  const end = inc.resolved_at ?? inc.last_signal_at;
  const markers: Marker[] = [
    ...data.changes.map((c) => ({ ts: c.changed_at, label: c.version ? `${c.version} deployed` : c.change_type, tone: 'change' as const })),
    ...data.runs.map((r) => ({ ts: r.started_at, label: 'agent', tone: 'agent' as const })),
    ...data.proposals.filter((p) => p.decided_at && p.status === 'executed').map((p) => ({ ts: p.decided_at, label: 'approved', tone: 'action' as const })),
  ];
  const leadMetric = lead && metric(lead.metric_id);
  const headline = inc.agent_verdict === 'confirmed' && inc.agent_cause
    ? inc.agent_cause
    : leadMetric && peak
      ? `${leadMetric.name} reached ${fmtMetric(peak.value, leadMetric.unit)} against an expected ${fmtMetric(peak.expected ?? peak.expected_high, leadMetric.unit)}`
      : `Abnormal ${data.signals.length} signal${data.signals.length === 1 ? '' : 's'} in ${inc.system_name}`;
  const latestRun = data.runs[0];
  const sysId = inc.system_id;
  const s = ntz(inc.opened_at);
  const e = ntz(end);

  return (
    <div className="space-y-6">
      <header className="animate-rise">
        <p className="text-sm text-muted-foreground">
          <Link href="/incidents" className="hover:text-foreground">Incidents</Link> / <Link href={`/systems/${sysId}`} className="hover:text-foreground">{inc.system_name}</Link>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', inc.status === 'open' ? 'bg-critical/15 text-critical' : 'bg-muted text-muted-foreground')}>
            {inc.status === 'open' ? 'Open' : 'Resolved'}
          </span>
          <VerdictBadge verdict={inc.agent_verdict} />
          <span className="text-xs text-muted-foreground">
            {dayTime(inc.opened_at)} → {inc.resolved_at ? hhmm(inc.resolved_at) : 'now'} · {minutesBetween(inc.opened_at, end)} min · severity {Number(inc.severity).toFixed(1)}
          </span>
        </div>
        <h1 className="mt-2 max-w-5xl text-3xl font-semibold leading-tight md:text-4xl">{headline}</h1>
        <Feedback incident={inc} />
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {lead && leadMetric && (
            <Section title={`Timeline · ${leadMetric.name}`} aside={<span className="text-xs text-muted-foreground">shaded = incident window · dashed = changes and agent</span>}>
              <SignalChart label={leadMetric.name} unit={leadMetric.unit} points={leadPts} markers={markers} window={[inc.opened_at, end]} height={220} loading={series.isPending} />
            </Section>
          )}

          <Section title="What changed before it started" aside={<span className="text-xs text-muted-foreground">all registered change feeds, 6 h before onset</span>}>
            {data.changes.length === 0 ? <p className="text-sm text-muted-foreground">No recorded changes. Look upstream for unregistered changes.</p> : (
              <ol className="relative space-y-3 border-l border-border pl-5">
                {data.changes.map((c) => {
                  const before = minutesBetween(c.changed_at, inc.opened_at);
                  return (
                    <li key={c.change_key} className="relative">
                      <GitCommitHorizontal className="absolute -left-[27px] top-0.5 h-4 w-4 rounded-full bg-card text-chart-4" aria-hidden />
                      <p className="text-sm"><span className="font-medium">{c.entity_name ?? c.change_type}</span> {c.previous_version && c.version ? `${c.previous_version} → ${c.version}` : c.change_type}</p>
                      <p className="text-xs text-muted-foreground">
                        {hhmm(c.changed_at)} · {before !== null && (Math.abs(before) < 5 ? 'at onset (same 5-min bucket)' : before > 0 ? `${before} min before onset` : `${-before} min after onset`)} · {c.author}{c.ref && <> · <span className="font-mono">{c.ref}</span></>}
                      </p>
                      <p className="mt-0.5 text-xs">{c.summary}</p>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>

          <Section title="Signal heatmap" aside={<span className="text-xs text-muted-foreground">± 2 h around onset · 5-min buckets</span>}>
            <Heatmap incidentId={id} openedAt={inc.opened_at} units={units} />
          </Section>

          <Section title="Where the excess is concentrated">
            <Slices incidentId={id} />
          </Section>

          <Section title="All signals in this incident">
            <div className="grid gap-5 md:grid-cols-2">
              {data.signals.map((sg) => {
                const m = metric(sg.metric_id);
                return (
                  <div key={sg.metric_id}>
                    <p className="text-sm font-medium">{m?.name ?? sg.metric_id}</p>
                    <p className="text-xs text-muted-foreground">{data.entities.find((x) => x.entity_id === sg.entity_id)?.name} · first abnormal {hhmm(sg.first_ts)} · {sg.buckets} buckets</p>
                    <SignalChart label={m?.name ?? sg.metric_id} unit={m?.unit} points={pts(sg.metric_id)} window={[inc.opened_at, end]} height={120} loading={series.isPending} />
                  </div>
                );
              })}
            </div>
          </Section>
        </div>

        <div className="min-w-0 space-y-6">
          <Section title="Agent investigation" className="border-agent/30"
            aside={latestRun && <Link href={`/agents/runs/${encodeURIComponent(latestRun.run_id)}`} className="flex items-center gap-1 text-xs text-agent hover:underline"><Bot className="h-3.5 w-3.5" />Open flight recorder</Link>}>
            {!latestRun ? <NoAgent agentSystem={sysId} /> : (
              <div className="space-y-5">
                <p className="text-sm">{latestRun.status_line ?? (latestRun.ended_at ? 'Run finished' : 'Investigating…')}</p>
                <HypothesisBoard hypotheses={data.hypotheses} entities={data.entities} />
                <div>
                  <h3 className="mb-2 text-sm font-medium">Counterfactual experiments</h3>
                  <Experiments experiments={data.experiments} />
                </div>
              </div>
            )}
          </Section>

          <Section title="Proposed actions">
            <Proposals proposals={data.proposals} />
          </Section>

          <Section title="Explore">
            <Explore templates={[
              { label: 'Signals in window', sql: `SELECT metric_id, ts, value, expected, is_abnormal\nFROM MLOPS_CONTROL.CORE.SIGNALS\nWHERE system_id = '${sysId}'\n  AND ts BETWEEN '${s}' AND '${e}'\nORDER BY ts DESC` },
              { label: 'Changes ±6h', sql: `SELECT changed_at, entity_id, change_type, version, summary, author\nFROM MLOPS_CONTROL.CORE.CHANGES\nWHERE system_id = '${sysId}'\n  AND changed_at BETWEEN DATEADD(hour, -6, '${s}'::TIMESTAMP_NTZ) AND '${e}'\nORDER BY changed_at` },
              { label: 'Agent events', sql: `SELECT run_id, seq, ts, kind, name, status, entity_id\nFROM MLOPS_CONTROL.CORE.AGENT_EVENTS\nWHERE incident_id = '${id}'\nORDER BY ts` },
            ]} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function NoAgent({ agentSystem }: { agentSystem: string }) {
  const agents = useApi<{ agents: Row[] }>('/api/agents', 60000);
  const agent = agents.data?.agents.find((a) => a.system_id === agentSystem);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">No agent has investigated this incident yet.</p>
      {agent && (
        <button className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          onClick={async () => { try { await postJson('/api/agents/run', { agent_id: agent.agent_id }); setMsg('Started. The run appears here within a minute.'); } catch (e) { setMsg((e as Error).message); } }}>
          Run {agent.name} now
        </button>
      )}
      {msg && <p className="text-xs" role="status">{msg}</p>}
    </div>
  );
}

const VERDICTS: [string, string][] = [['correct', 'Agent was right'], ['partially_correct', 'Partly right'], ['wrong', 'Agent was wrong'], ['not_an_incident', 'Not an incident']];

function Feedback({ incident }: { incident: Row }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!incident.agent_verdict && !incident.human_verdict) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Your verdict on the agent:</span>
      {VERDICTS.map(([v, l]) => (
        <button key={v} disabled={busy} aria-pressed={incident.human_verdict === v}
          onClick={async () => {
            setBusy(true); setErr(null);
            try { await postJson(`/api/incidents/${incident.incident_id}/verdict`, { verdict: v }); qc.invalidateQueries(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}
          className={cn('rounded-full border border-border px-2.5 py-1 hover:border-foreground/40', incident.human_verdict === v && 'border-brand bg-brand/15 text-brand')}>
          {l}
        </button>
      ))}
      {incident.human_by && <span className="text-muted-foreground">· recorded by {incident.human_by}</span>}
      {err && <span className="text-critical">{err}</span>}
    </div>
  );
}
