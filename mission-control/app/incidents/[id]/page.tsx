'use client';

import { Experiments, HypothesisBoard } from '@/components/incident/hypotheses';
import { Explore } from '@/components/incident/explore';
import { Heatmap } from '@/components/incident/heatmap';
import { Proposals } from '@/components/incident/proposals';
import { AgentReport } from '@/components/incident/report';
import { Slices } from '@/components/incident/slices';
import { SignalChart, type Marker, type SignalPoint } from '@/components/signal-chart';
import { ErrorState, More, VerdictBadge } from '@/components/status';
import { postJson, useApi } from '@/lib/client';
import { fmtMetric, HUMAN_VERDICT_LABEL, incidentTitle, normalRange, runSummary, severityLabel, stripRefs } from '@/lib/status';
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
type Me = { approver: boolean };

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

const Note = ({ children }: { children: React.ReactNode }) => <span className="text-xs text-muted-foreground">{children}</span>;

function ChartKey() {
  const item = (style: React.CSSProperties, label: string) => (
    <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm" style={style} />{label}</span>
  );
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {item({ background: 'var(--foreground)', height: 2 }, 'Actual')}
      {item({ background: 'color-mix(in oklab, var(--brand) 25%, transparent)' }, 'Normal range')}
      {item({ background: 'color-mix(in oklab, var(--critical) 18%, transparent)' }, 'Incident')}
      {item({ borderLeft: '2px dashed var(--chart-4)', width: 2 }, 'Change deployed')}
      {item({ borderLeft: '2px dashed var(--agent)', width: 2 }, 'Agent ran')}
      {item({ borderLeft: '2px dashed var(--brand)', width: 2 }, 'Fix approved')}
    </div>
  );
}

function when(min: number | null) {
  if (min === null) return '';
  if (Math.abs(min) < 5) return 'right at the start';
  return min > 0 ? `${min} min before the start` : `${-min} min after the start`;
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
  const ename = (eid?: string) => data.entities.find((x) => x.entity_id === eid)?.name;
  const units = Object.fromEntries(data.metrics.map((m) => [m.metric_id, m.unit]));
  // lead signal: output metrics first, then severity
  const lead = [...data.signals].sort((a, b) =>
    (metric(b.metric_id)?.golden_class === 'output' ? 1 : 0) - (metric(a.metric_id)?.golden_class === 'output' ? 1 : 0) || Number(b.max_severity) - Number(a.max_severity))[0];
  const pts = (mid: string) => (series.data?.rows ?? []).filter((r) => r.metric_id === mid) as SignalPoint[];
  const leadPts = lead ? pts(lead.metric_id) : [];
  const peak = leadPts.filter((p) => p.is_abnormal).sort((a, b) => Number(b.value) - Number(a.value))[0];
  const end = inc.resolved_at ?? inc.last_signal_at;
  const markers: Marker[] = [
    ...data.changes.map((c) => ({ ts: c.changed_at, label: c.version ? `${c.version} deployed` : 'change', tone: 'change' as const })),
    ...data.runs.map((r) => ({ ts: r.started_at, label: 'agent', tone: 'agent' as const })),
    ...data.proposals.filter((p) => p.decided_at && p.status === 'executed').map((p) => ({ ts: p.decided_at, label: 'fix approved', tone: 'action' as const })),
  ];
  const leadMetric = lead && metric(lead.metric_id);
  const proof = data.experiments.find((x) => x.pass);
  const cause = data.hypotheses.find((h) => h.status === 'confirmed');
  // the change to the causing component closest before the start
  const causeChange = cause && [...data.changes].reverse().find((c) => c.entity_id === cause.component && (minutesBetween(c.changed_at, inc.opened_at) ?? -1) >= -5);
  const explained = proof ? Math.min(100, Math.round(Number(proof.explained_pct))) : null;
  const latestRun = data.runs[0];
  const sysId = inc.system_id;
  const s = ntz(inc.opened_at);
  const e = ntz(end);
  const durMin = minutesBetween(inc.opened_at, inc.resolved_at ?? undefined) ?? minutesBetween(inc.opened_at, end);
  const open = inc.status === 'open';
  const others = data.signals.length - 1;
  const title = leadMetric
    ? `${leadMetric.name} went outside normal${others > 0 ? `, with ${others} other health check${others === 1 ? '' : 's'}` : ''}`
    : incidentTitle(inc.title);

  // Summary: what happened, likely cause, evidence
  const what = leadMetric && peak
    ? `${leadMetric.name} reached ${fmtMetric(peak.value, leadMetric.unit)} (${normalRange({ ...peak, unit: leadMetric.unit })}) from ${hhmm(inc.opened_at)}.`
    : `${data.signals.length} health check${data.signals.length === 1 ? '' : 's'} went outside normal from ${hhmm(inc.opened_at)}.`;
  const likely = cause
    ? `${ename(cause.component) ?? 'A component'}: ${stripRefs(cause.text)}${causeChange ? ` (changed at ${hhmm(causeChange.changed_at)})` : ''}.`
    : latestRun ? 'Not proven yet.' : 'Not investigated yet.';
  const evidence = explained !== null && cause
    ? `Undoing it removes ${explained >= 100 ? 'all' : `${explained}%`} of the extra ${leadMetric?.golden_class === 'output' ? 'flags' : 'deviation'}.`
    : null;

  return (
    <div className="space-y-6">
      <header className="animate-rise">
        <p className="text-sm text-muted-foreground">
          <Link href="/incidents" className="hover:text-foreground">Incidents</Link> / <Link href={`/systems/${sysId}`} className="hover:text-foreground">{inc.system_name}</Link>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', open ? 'bg-critical/15 text-critical' : 'bg-muted text-muted-foreground')}>
            {open ? 'Open' : 'Resolved'}
          </span>
          <VerdictBadge verdict={inc.agent_verdict} />
          <span className="text-xs text-muted-foreground">
            {dayTime(inc.opened_at)} → {inc.resolved_at ? hhmm(inc.resolved_at) : 'ongoing'} · {durMin} min · {severityLabel(inc.severity)} severity
          </span>
        </div>
        <h1 className="mt-2 max-w-5xl text-3xl font-semibold leading-tight md:text-4xl">{title}</h1>

        <dl className="mt-4 grid max-w-5xl gap-3 rounded-xl border border-border bg-card p-4 text-sm md:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">What happened</dt><dd className="mt-0.5">{what}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Likely cause</dt><dd className={cn('mt-0.5', cause && 'font-medium')}>{likely}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Evidence</dt><dd className="mt-0.5">{evidence ?? '—'}</dd></div>
        </dl>
        <Feedback incident={inc} />
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {lead && leadMetric && (
            <Section title={`What happened · ${leadMetric.name}`}>
              <SignalChart label={leadMetric.name} unit={leadMetric.unit} points={leadPts} markers={markers} window={[inc.opened_at, end]} height={220} loading={series.isPending} />
              <ChartKey />
            </Section>
          )}

          <Section title="What changed just before" aside={<Note>changes in the 6 hours before the start</Note>}>
            {data.changes.length === 0 ? <p className="text-sm text-muted-foreground">No recorded changes. The cause may be outside the systems we track.</p> : (
              <ChangeList changes={data.changes} openedAt={inc.opened_at} />
            )}
          </Section>

          <Section title="Where it's happening" aside={<Note>compared with the same hours last week</Note>}>
            <Slices incidentId={id} />
          </Section>

          <More label="More evidence: every health check around the start, and a query editor">
            <div className="space-y-6">
              <div>
                <h3 className="mb-1 text-sm font-medium">Which checks broke first</h3>
                <p className="mb-3 text-xs text-muted-foreground">Each row is a health check, each square 5 minutes, 2 hours either side of the start. The top row broke first.</p>
                <Heatmap incidentId={id} openedAt={inc.opened_at} units={units} />
              </div>
              <div>
                <h3 className="mb-1 text-sm font-medium">Query the data yourself</h3>
                <Explore templates={[
                  { label: 'Health readings during the incident', sql: `SELECT metric_id, ts, value, expected, is_abnormal\nFROM MLOPS_CONTROL.CORE.SIGNALS\nWHERE system_id = '${sysId}'\n  AND ts BETWEEN '${s}' AND '${e}'\nORDER BY ts DESC` },
                  { label: 'Changes 6 h either side', sql: `SELECT changed_at, entity_id, change_type, version, summary, author\nFROM MLOPS_CONTROL.CORE.CHANGES\nWHERE system_id = '${sysId}'\n  AND changed_at BETWEEN DATEADD(hour, -6, '${s}'::TIMESTAMP_NTZ) AND DATEADD(hour, 6, '${s}'::TIMESTAMP_NTZ)\nORDER BY changed_at` },
                  { label: 'What the agent did', sql: `SELECT run_id, seq, ts, kind, name, status, entity_id\nFROM MLOPS_CONTROL.CORE.AGENT_EVENTS\nWHERE incident_id = '${id}'\nORDER BY ts` },
                ]} />
              </div>
            </div>
          </More>
        </div>

        <div className="min-w-0 space-y-6">
          <Section title="Agent findings" className="border-agent/30"
            aside={latestRun && <Link href={`/agents/runs/${encodeURIComponent(latestRun.run_id)}`} className="flex items-center gap-1 text-xs text-agent hover:underline"><Bot className="h-3.5 w-3.5" />Replay the run</Link>}>
            {!latestRun ? <NoAgent agentSystem={sysId} /> : (
              <div className="space-y-5">
                <p className="text-sm">{latestRun.ended_at ? runSummary(latestRun.status_line, latestRun.verdict) || 'Run finished.' : 'Investigating…'}</p>
                {latestRun.ended_at && (
                  <More label="Read the agent's full report" defaultOpen>
                    <AgentReport body={latestRun.report} subject={latestRun.report_subject} summary={latestRun.report_summary} />
                  </More>
                )}
                <HypothesisBoard hypotheses={data.hypotheses} entities={data.entities} />
                <div>
                  <h3 className="text-sm font-medium">What-if tests</h3>
                  <p className="mb-2 text-xs text-muted-foreground">The agent re-scores the same transactions with one thing undone. If the problem disappears, that thing caused it.</p>
                  <Experiments experiments={data.experiments} entities={data.entities} />
                </div>
              </div>
            )}
          </Section>

          <Section title="Recommended fix">
            <Proposals proposals={data.proposals} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function ChangeList({ changes, openedAt }: { changes: Row[]; openedAt: string }) {
  const [all, setAll] = useState(false);
  const newest = [...changes].reverse();
  const shown = all ? newest : newest.slice(0, 3);
  return (
    <>
      <ol className="relative space-y-3 border-l border-border pl-5">
        {shown.map((c) => (
          <li key={c.change_key} className="relative">
            <GitCommitHorizontal className="absolute -left-[27px] top-0.5 h-4 w-4 rounded-full bg-card text-chart-4" aria-hidden />
            <p className="text-sm">
              <span className="font-medium">{c.entity_name ?? 'Other change'}</span>{' '}
              {c.previous_version && c.version ? `updated ${c.previous_version} → ${c.version}` : String(c.change_type ?? '').replace(/^ddl:/, 'table change: ').replaceAll('_', ' ').toLowerCase()}
            </p>
            <p className="text-xs text-muted-foreground">
              {hhmm(c.changed_at)} · {when(minutesBetween(c.changed_at, openedAt))}
              {c.author && ` · ${String(c.author).startsWith('cd:') ? 'automatic deploy' : `by ${c.author}`}`}
            </p>
            {c.summary && <p className="mt-0.5 text-xs">{c.summary}</p>}
          </li>
        ))}
      </ol>
      {changes.length > 3 && (
        <button onClick={() => setAll(!all)} className="mt-3 text-xs text-muted-foreground hover:text-foreground hover:underline">
          {all ? 'Show the latest 3' : `Show all ${changes.length} changes`}
        </button>
      )}
    </>
  );
}

function NoAgent({ agentSystem }: { agentSystem: string }) {
  const agents = useApi<{ agents: Row[] }>('/api/agents', 60000);
  const me = useApi<Me>('/api/me', 300000);
  const agent = agents.data?.agents.find((a) => a.system_id === agentSystem);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">No agent has investigated this incident yet.</p>
      {agent && (me.data?.approver ? (
        <button className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          onClick={async () => { try { await postJson('/api/agents/run', { agent_id: agent.agent_id }); setMsg('Started. The run appears here within a minute.'); } catch (e) { setMsg((e as Error).message); } }}>
          Run {agent.name} now
        </button>
      ) : <p className="text-xs text-muted-foreground">Approvers can start an agent run.</p>)}
      {msg && <p className="text-xs" role="status">{msg}</p>}
    </div>
  );
}

const VERDICTS = Object.entries(HUMAN_VERDICT_LABEL);

function Feedback({ incident }: { incident: Row }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!incident.agent_verdict && !incident.human_verdict) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Was the agent right?</span>
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
      {incident.human_by && <span className="text-muted-foreground">· answered by {incident.human_by}</span>}
      {err && <span className="text-critical">{err}</span>}
    </div>
  );
}
