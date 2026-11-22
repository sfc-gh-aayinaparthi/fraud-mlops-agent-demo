'use client';

import { EmptyState, ErrorState } from '@/components/status';
import { useApi } from '@/lib/client';
import { dayTime, minutesBetween } from '@/lib/time';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type React from 'react';

type Row = Record<string, any>;
type Gov = { log: Row[]; accuracy: Row[]; mttx: Row[]; coverage: Row[]; policy: Row[] };

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5" aria-label={title}>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

export default function GovernancePage() {
  const { data, error, isPending } = useApi<Gov>('/api/governance', 30000);
  if (error) return <ErrorState error={error} />;
  if (isPending || !data) return <div className="h-[60vh] animate-pulse rounded-xl bg-muted/40" />;
  const reviewed = data.accuracy.reduce((s, a) => s + Number(a.reviewed), 0);
  const correct = data.accuracy.reduce((s, a) => s + Number(a.correct) + 0.5 * Number(a.partial), 0);
  const gaps = data.coverage.filter((c) => (c.gaps ?? []).length);
  const ttm = data.mttx.map((m) => minutesBetween(m.opened_at, m.mitigated_at)).filter((v): v is number => v !== null);

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm text-muted-foreground">Governance · how far to trust the agents, and what they may do</p>
        <h1 className="mt-1 text-4xl font-semibold">
          {reviewed ? `Agents were right on ${Math.round((correct / reviewed) * 100)}% of ${reviewed} reviewed incident${reviewed > 1 ? 's' : ''}` : 'No agent verdicts reviewed yet'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {ttm.length ? `Median time from incident to approved fix: ${ttm.sort((a, b) => a - b)[Math.floor(ttm.length / 2)]} min. ` : ''}
          {gaps.length} component{gaps.length === 1 ? '' : 's'} with coverage gaps limit what agents can see or test.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Agent accuracy" note="from engineers' verdicts in the Incident Room">
          {data.accuracy.length === 0 ? <EmptyState title="No incidents yet" /> : data.accuracy.map((a) => {
            const parts: [string, number, string][] = [
              ['Correct', Number(a.correct), 'var(--brand)'], ['Partly', Number(a.partial), 'var(--chart-4)'],
              ['Wrong', Number(a.wrong), 'var(--critical)'], ['False alarm', Number(a.false_alarm), 'var(--warning)'],
            ];
            const total = Math.max(1, Number(a.reviewed));
            return (
              <div key={a.system_id} className="space-y-2">
                <p className="text-sm"><span className="font-medium">{a.system_id}</span> · {a.incidents} incidents · {a.investigated} investigated · {a.reviewed} reviewed</p>
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

        <Panel title="Action policy" note="MLOPS_CONTROL.CORE.ACTION_TYPES">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground"><tr><th className="pb-2 font-medium">Action</th><th className="pb-2 font-medium">Approval</th><th className="pb-2 font-medium">Rollback</th></tr></thead>
            <tbody>
              {data.policy.map((p) => (
                <tr key={p.action_type} className="border-t border-border/60">
                  <td className="py-2"><span className="font-mono text-xs">{p.action_type}</span><span className="block text-xs text-muted-foreground">{p.description}</span></td>
                  <td className="py-2 text-xs">{p.requires_approval ? <span className="rounded bg-agent/15 px-1.5 py-0.5 text-agent">{p.approver_role}</span> : 'Agent may act'}</td>
                  <td className="py-2 text-xs text-muted-foreground">{p.rollback}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Incident response times" note="onset → first agent run → approved fix">
        {data.mttx.length === 0 ? <EmptyState title="No incidents yet" /> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="pb-2 font-medium">Opened</th><th className="pb-2 font-medium">System</th><th className="pb-2 text-right font-medium">To agent</th><th className="pb-2 text-right font-medium">To approved fix</th><th className="pb-2 text-right font-medium">To resolved</th></tr>
            </thead>
            <tbody>
              {data.mttx.map((m) => {
                const cell = (v: number | null) => <td className="tabular py-2 text-right">{v === null ? '—' : `${v} min`}</td>;
                return (
                  <tr key={m.incident_id} className="border-t border-border/60">
                    <td className="tabular py-2"><Link className="hover:text-brand" href={`/incidents/${m.incident_id}`}>{dayTime(m.opened_at)}</Link></td>
                    <td className="py-2">{m.system_id}</td>
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

      <Panel title="Coverage gaps" note="what agents cannot see or test">
        {gaps.length === 0 ? <p className="text-sm text-muted-foreground">Every component has monitors, lineage and (where relevant) a deploy hook.</p> : (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {gaps.map((c) => (
              <li key={c.entity_id} className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium">{c.name}</p>
                <p className="text-xs text-muted-foreground">{c.system_id} · {c.stage} · {c.metrics} monitors</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(c.gaps as string[]).map((g) => <span key={g} className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning">{g}</span>)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Audit log" note="every run request, approval, rejection, deploy and verdict">
        {data.log.length === 0 ? <EmptyState title="Nothing recorded yet" /> : (
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                <tr><th className="pb-2 font-medium">When</th><th className="pb-2 font-medium">Who</th><th className="pb-2 font-medium">Action</th><th className="pb-2 font-medium">Target</th><th className="pb-2 font-medium">Outcome</th></tr>
              </thead>
              <tbody>
                {data.log.map((l) => {
                  const t = l.target;
                  const target = t && typeof t === 'object' ? (t.pr_number ? `PR #${t.pr_number}` : JSON.stringify(t)) : String(t ?? '—');
                  return (
                  <tr key={l.log_id} className="border-t border-border/60 align-top">
                    <td className="tabular whitespace-nowrap py-2 pr-3">{dayTime(l.ts)}</td>
                    <td className="py-2 pr-3">{l.actor}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{l.action}</td>
                    <td className="max-w-[18rem] truncate py-2 pr-3 text-xs text-muted-foreground" title={target}>{target}</td>
                    <td className="py-2"><span className={cn('rounded px-1.5 py-0.5 text-xs', l.outcome === 'failed' ? 'bg-critical/15 text-critical' : 'bg-muted')}>{l.outcome}</span></td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
