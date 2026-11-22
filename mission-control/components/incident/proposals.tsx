'use client';

import { Button } from '@/components/ui/button';
import { postJson, useApi } from '@/lib/client';
import { dayTime } from '@/lib/time';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

type Row = Record<string, any>;
type Me = { user: string | null; approver: boolean; identity: string };

const LABEL: Record<string, string> = {
  merge_pr: 'Merge pull request', open_pr: 'Pull request opened', rollback_model_default: 'Roll back model default',
  suspend_task: 'Suspend task', escalate: 'Escalate to on-call', close_pr: 'Close pull request',
};

/** Typed actions proposed by agents, gated by the approval policy in ACTION_TYPES. */
export function Proposals({ proposals }: { proposals: Row[] }) {
  const me = useApi<Me>('/api/me', 300000);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<Record<string, string>>({});
  if (!proposals.length) return <p className="text-sm text-muted-foreground">No actions proposed.</p>;

  const decide = async (p: Row, decision: 'approve' | 'reject') => {
    if (decision === 'approve' && !confirm(`${LABEL[p.action_type] ?? p.action_type}?\n\nThis runs in production and is recorded under your name. Rollback: ${p.rollback ?? 'n/a'}`)) return;
    setBusy(p.proposal_id);
    try {
      const r = await postJson<{ result: Row }>(`/api/proposals/${encodeURIComponent(p.proposal_id)}`, { decision, note });
      const res = r.result ?? {};
      setMsg((m) => ({ ...m, [p.proposal_id]: res.ok ? `Done: ${res.outcome}${res.result?.deploys ? ` · ${res.result.deploys.join('; ')}` : ''}` : `Failed: ${res.error ?? res.result?.error ?? res.result?.message ?? 'unknown error'}` }));
      qc.invalidateQueries();
    } catch (e) {
      setMsg((m) => ({ ...m, [p.proposal_id]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ul className="space-y-3">
      {proposals.map((p) => {
        const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params ?? {};
        const waiting = p.status === 'awaiting_approval';
        return (
          <li key={p.proposal_id} className={waiting ? 'rounded-lg border border-agent/50 bg-agent/5 p-3' : 'rounded-lg border border-border p-3'}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{LABEL[p.action_type] ?? p.action_type}</p>
                <p className="text-xs text-muted-foreground">{dayTime(p.proposed_at)} · proposed by agent</p>
              </div>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{String(p.status).replaceAll('_', ' ')}</span>
            </div>
            {p.rationale && <p className="mt-2 text-xs">{p.rationale}</p>}
            {params.pr_url && (
              <a href={params.pr_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-brand hover:underline">
                PR #{params.pr_number} <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {p.requires_approval && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Requires {p.approver_role} · rollback: {p.rollback}
              </p>
            )}
            {p.decided_by && <p className="mt-1 text-[11px] text-muted-foreground">Decided by {p.decided_by} at {dayTime(p.decided_at)}</p>}
            {waiting && (
              me.data?.approver ? (
                <div className="mt-3 space-y-2">
                  <label className="sr-only" htmlFor={`note-${p.proposal_id}`}>Decision note</label>
                  <input id={`note-${p.proposal_id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional, saved to the audit log)"
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs" />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy === p.proposal_id} onClick={() => decide(p, 'approve')}>{busy === p.proposal_id ? 'Working…' : 'Approve'}</Button>
                    <Button size="sm" variant="outline" disabled={busy === p.proposal_id} onClick={() => decide(p, 'reject')}>Reject</Button>
                  </div>
                </div>
              ) : (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" /> You need {p.approver_role} to decide.</p>
              )
            )}
            {msg[p.proposal_id] && <p className="mt-2 text-xs" role="status">{msg[p.proposal_id]}</p>}
          </li>
        );
      })}
    </ul>
  );
}
