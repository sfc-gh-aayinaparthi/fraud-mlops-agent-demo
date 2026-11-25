'use client';

import { EmptyState, ErrorState } from '@/components/status';
import { useApi } from '@/lib/client';
import { actionLabel, auditLabel, GAP_LABEL, HUMAN_VERDICT_LABEL, incidentTitle, plural } from '@/lib/status';
import { dayTime, minutesBetween } from '@/lib/time';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type React from 'react';
import { useState } from 'react';

type Row = Record<string, any>;
type Gov = { log: Row[]; accuracy: Row[]; mttx: Row[]; coverage: Row[]; policy: Row[]; names: Row[] };

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5" aria-label={title}>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {note && <span className="text-right text-xs text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

const OUTCOME: Record<string, string> = { executed: 'Done', failed: 'Failed', rejected: 'Rejected', recorded: 'Recorded' };

export default function GovernancePage() {
  const { data, error, isPending } = useApi<Gov>('/api/governance', 30000);
  const [allLog, setAllLog] = useState(false);
  if (error) return <ErrorState error={error} />;
  if (isPending || !data) return <div className="h-[60vh] animate-pulse rounded-xl bg-muted/40" />;
  const reviewed = data.accuracy.reduce((s, a) => s + Number(a.reviewed), 0);
  const correct = data.accuracy.reduce((s, a) => s + Number(a.correct) + 0.5 * Number(a.partial), 0);
  const gaps = data.coverage.filter((c) => (c.gaps ?? []).length);
  const ttm = data.mttx.map((m) => minutesBetween(m.opened_at, m.mitigated_at)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const median = ttm.length ? (ttm.length % 2 ? ttm[(ttm.length - 1) / 2] : Math.round((ttm[ttm.length / 2 - 1] + ttm[ttm.length / 2]) / 2)) : null;
  const nameOf = new Map(data.names.map((n) => [n.entity_id, n.name]));
  const target = (t: unknown) => {
    if (t && typeof t === 'object') {
      const o = t as Row;
      return o.pr_number ? `Pull request #${o.pr_number}` : o.entity_id ? nameOf.get(o.entity_id) ?? o.entity_id : o.incident_id ? 'Incident' : '—';
    }
    return t ? nameOf.get(String(t)) ?? String(t) : '—';
  };
  const log = allLog ? data.log : data.log.slice(0, 20);

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm text-muted-foreground">Governance · how much to trust the agents, and what they&rsquo;re allowed to do</p>
        <h1 className="mt-1 text-4xl font-semibold">
          {reviewed ? `Agents were right on ${Math.round((correct / reviewed) * 100)}% of ${plural(reviewed, 'graded incident')}` : 'No one has graded the agents yet'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {reviewed ? '“Partly right” counts as half. ' : ''}
          {median !== null ? `Typical time from incident start to approved fix: ${median} min. ` : ''}
          {gaps.length ? `${plural(gaps.length, 'component')} ${gaps.length === 1 ? 'is a blind spot' : 'are blind spots'} for the agents.` : ''}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Agent accuracy" note="from engineers grading each incident">
          {data.accuracy.length === 0 ? <EmptyState title="No incidents yet" /> : data.accuracy.map((a) => {
            const parts: [string, number, string][] = [
              [HUMAN_VERDICT_LABEL.correct, Number(a.correct), 'var(--brand)'], [HUMAN_VERDICT_LABEL.partially_correct, Number(a.partial), 'var(--chart-4)'],
              [HUMAN_VERDICT_LABEL.wrong, Number(a.wrong), 'var(--critical)'], [HUMAN_VERDICT_LABEL.not_an_incident, Number(a.false_alarm), 'var(--warning)'],
            ];
            const total = Math.max(1, Number(a.reviewed));
            return (
              <div key={a.system_id} className="space-y-2 [&+&]:mt-5">
                <p className="text-sm"><span className="font-medium">{a.system_name ?? a.system_id}</span> · {plural(Number(a.incidents), 'incident')} · {a.investigated} investigated · {a.reviewed} graded</p>
                <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={parts.map(([l, n]) => `${l} ${n}`).join(', ')}>
                  {parts.map(([l, n, c]) => n > 0 && <div key={l} style={{ width: `${(n / total) * 100}%`, background: c }} />)}
                </div>
                <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {parts.map(([l, n, c]) => <li key={l} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{l} {n}</li>)}
                </ul>
              </div>
            );
          })}
        </Panel>

        <Panel title="What agents may do" note="anything marked “Approver required” waits for a person">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground"><tr><th className="pb-2 font-medium">Action</th><th className="pb-2 font-medium">Who decides</th><th className="pb-2 font-medium">How to undo</th></tr></thead>
            <tbody>
              {data.policy.map((p) => (
                <tr key={p.action_type} className="border-t border-border/60 align-top">
                  <td className="py-2 pr-3">{actionLabel(p.action_type)}<span className="block text-xs text-muted-foreground">{p.description}</span></td>
                  <td className="py-2 pr-3 text-xs">{p.requires_approval
                    ? <span className="rounded bg-agent/15 px-1.5 py-0.5 text-agent" title={p.approver_role}>Approver required</span>
                    : 'Agent may act'}</td>
                  <td className="py-2 text-xs text-muted-foreground">{p.rollback ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Response times" note="minutes from incident start to: agent run → approved fix → resolved">
        {data.mttx.length === 0 ? <EmptyState title="No incidents yet" /> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="pb-2 font-medium">Incident</th><th className="pb-2 font-medium">System</th><th className="pb-2 text-right font-medium">Agent ran</th><th className="pb-2 text-right font-medium">Fix approved</th><th className="pb-2 text-right font-medium">Resolved</th></tr>
            </thead>
            <tbody>
              {data.mttx.slice(0, 10).map((m) => {
                const cell = (v: number | null) => <td className="tabular py-2 text-right">{v === null ? '—' : `${v} min`}</td>;
                return (
                  <tr key={m.incident_id} className="border-t border-border/60">
                    <td className="py-2 pr-3"><Link className="hover:text-brand" href={`/incidents/${m.incident_id}`}>{dayTime(m.opened_at)}</Link>
                      {m.title && <span className="block max-w-[22rem] truncate text-xs text-muted-foreground">{incidentTitle(m.title)}</span>}</td>
                    <td className="py-2">{m.system_name ?? m.system_id}</td>
                    {cell(minutesBetween(m.opened_at, m.first_agent_at))}
                    {cell(minutesBetween(m.opened_at, m.mitigated_at))}
                    {cell(minutesBetween(m.opened_at, m.resolved_at))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Blind spots" note="components agents can't fully watch or test">
        {gaps.length === 0 ? <p className="text-sm text-muted-foreground">No blind spots: every component has health checks, known upstream data and (where relevant) automatic deploys.</p> : (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {gaps.map((c) => (
              <li key={c.entity_id} className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium">{c.name}</p>
                <p className="text-xs text-muted-foreground">{c.system_name ?? c.system_id} · {plural(Number(c.metrics ?? 0), 'health check')}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(c.gaps as string[]).map((g) => <span key={g} className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning">{GAP_LABEL[g] ?? g}</span>)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Audit log" note="every agent run, approval, rejection, deploy and grade">
        {data.log.length === 0 ? <EmptyState title="Nothing recorded yet" /> : (
          <>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="pb-2 font-medium">When</th><th className="pb-2 font-medium">Who</th><th className="pb-2 font-medium">What</th><th className="pb-2 font-medium">On</th><th className="pb-2 font-medium">Result</th></tr>
              </thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.log_id} className="border-t border-border/60 align-top">
                    <td className="tabular whitespace-nowrap py-2 pr-3">{dayTime(l.ts)}</td>
                    <td className="py-2 pr-3">{l.actor}</td>
                    <td className="py-2 pr-3 text-xs">{auditLabel(l.action)}</td>
                    <td className="max-w-[18rem] truncate py-2 pr-3 text-xs text-muted-foreground">{target(l.target)}</td>
                    <td className="py-2"><span className={cn('rounded px-1.5 py-0.5 text-xs', l.outcome === 'failed' ? 'bg-critical/15 text-critical' : 'bg-muted')}>{OUTCOME[l.outcome] ?? l.outcome}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.log.length > 20 && (
              <button onClick={() => setAllLog(!allLog)} className="mt-3 text-xs text-muted-foreground hover:text-foreground hover:underline">
                {allLog ? 'Show latest 20' : `Show all ${data.log.length}`}
              </button>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
