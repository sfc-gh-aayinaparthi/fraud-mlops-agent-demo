'use client';

import { EmptyState, ErrorState, VerdictBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { postJson, useApi } from '@/lib/client';
import { plural, triggerLabel } from '@/lib/status';
import { ago, dayTime, minutesBetween, ms } from '@/lib/time';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Lock, Play, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Row = Record<string, any>;
type Data = { agents: Row[]; runs: Row[]; freshness: { now_ts: string } };
type Me = { approver: boolean };

export default function AgentsPage() {
  const { data, error, isPending } = useApi<Data>('/api/agents', 10000);
  const me = useApi<Me>('/api/me', 300000);
  if (error) return <ErrorState error={error} />;
  if (isPending || !data) return <div className="h-[60vh] animate-pulse rounded-xl bg-muted/40" />;
  const now = data.freshness.now_ts;
  const live = data.runs.filter((r) => !r.ended_at && (ms(now) - ms(r.last_event_at)) / 60000 < 10);

  return (
    <div className="space-y-10">
      <div className="animate-rise">
        <p className="text-sm text-muted-foreground">Agents · investigate incidents on their own; a person approves every fix</p>
        <h1 className="mt-1 text-4xl font-semibold">{live.length ? `${plural(live.length, 'agent')} investigating now` : 'No agent is running right now'}</h1>
      </div>

      <section aria-labelledby="agents-h" className="grid gap-4 md:grid-cols-2">
        <h2 id="agents-h" className="sr-only">Agents</h2>
        {data.agents.map((a) => (
          <AgentCard key={a.agent_id} agent={a} approver={Boolean(me.data?.approver)} runs={data.runs.filter((r) => r.agent_id === a.agent_id)} now={now} />
        ))}
      </section>

      <section aria-labelledby="runs-h">
        <h2 id="runs-h" className="mb-3 text-sm font-medium text-muted-foreground">Run history · click a run to replay it step by step</h2>
        {data.runs.length === 0 ? <EmptyState title="No runs recorded yet" /> : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2.5 font-medium">Started</th>
                  <th className="px-4 py-2.5 font-medium">Agent</th>
                  <th className="px-4 py-2.5 font-medium">Why it ran</th>
                  <th className="px-4 py-2.5 font-medium">Result</th>
                  <th className="px-4 py-2.5 text-right font-medium">What-if tests</th>
                  <th className="px-4 py-2.5 text-right font-medium">Took</th>
                  <th className="px-4 py-2.5 font-medium">Fix proposed</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.run_id} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                    <td className="tabular whitespace-nowrap px-4 py-2.5">
                      <Link href={`/agents/runs/${encodeURIComponent(r.run_id)}`} className="hover:text-brand">{dayTime(r.started_at)}</Link>
                    </td>
                    <td className="px-4 py-2.5">{r.agent_name}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{triggerLabel(r.trigger_type)}</td>
                    <td className="px-4 py-2.5">{r.ended_at ? <VerdictBadge verdict={r.verdict} /> : <span className="text-xs font-medium text-agent">Running</span>}</td>
                    <td className="tabular px-4 py-2.5 text-right">{r.experiments}</td>
                    <td className="tabular px-4 py-2.5 text-right">{minutesBetween(r.started_at, r.ended_at ?? r.last_event_at)} min</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{Number(r.proposals) > 0 ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function AgentCard({ agent, runs, now, approver }: { agent: Row; runs: Row[]; now: string; approver: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [requested, setRequested] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const last = runs[0];

  // after "Run now", pull traces until the new run's first event lands, then open it
  useEffect(() => {
    if (!requested) return;
    const t = setInterval(async () => {
      await postJson('/api/agents/refresh', {}).catch(() => {});
      qc.invalidateQueries({ queryKey: ['/api/agents'] });
    }, 6000);
    return () => clearInterval(t);
  }, [requested, qc]);
  useEffect(() => {
    if (!requested || !last) return;
    if (ms(last.started_at) >= requested - 120000 && (ms(now) - ms(last.started_at)) / 60000 < 5) {
      setRequested(null);
      router.push(`/agents/runs/${encodeURIComponent(last.run_id)}`);
    }
  }, [last, requested, now, router]);

  return (
    <article className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-lg bg-agent/15 text-agent"><Bot className="h-5 w-5" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold">{agent.name}</h3>
          <p className="text-sm text-muted-foreground">{agent.description}</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-muted-foreground">System</dt><dd className="mt-0.5">{agent.system_name}</dd></div>
        <div><dt className="text-muted-foreground">Last run</dt><dd className="mt-0.5">{last ? ago(last.started_at, now) : 'Never'}</dd></div>
        <div className="col-span-2">
          <dt className="flex items-center gap-1 text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" /> What it&rsquo;s allowed to do</dt>
          <dd className="mt-1"><ul className="space-y-1 text-xs">
            <li>Reads data only; it can&rsquo;t change anything in Snowflake.</li>
            <li>Can run what-if tests to prove a cause.</li>
            <li>Proposes fixes as code changes; a person must approve before anything changes.</li>
          </ul></dd>
        </div>
      </dl>
      <div className="mt-4 flex items-center gap-3">
        {approver ? (
          <Button size="sm" disabled={Boolean(requested)} className="bg-agent text-white hover:bg-agent/90"
            onClick={async () => {
              setErr(null);
              try { await postJson('/api/agents/run', { agent_id: agent.agent_id }); setRequested(ms(now)); } catch (e) { setErr((e as Error).message); }
            }}>
            <Play className="h-3.5 w-3.5" /> {requested ? 'Starting… the run opens in about a minute' : 'Run now'}
          </Button>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" /> Approvers can start runs</span>
        )}
        {err && <span className="text-xs text-critical">{err}</span>}
      </div>
    </article>
  );
}
