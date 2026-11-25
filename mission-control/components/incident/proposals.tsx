'use client';

import { Button } from '@/components/ui/button';
import { postJson, useApi } from '@/lib/client';
import { actionLabel, PROPOSAL_STATUS } from '@/lib/status';
import { dayTime } from '@/lib/time';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

type Row = Record<string, any>;
type Me = { user: string | null; approver: boolean; identity: string };


/** Typed actions proposed by agents, gated by the approval policy in ACTION_TYPES. */
export function Proposals({ proposals }: { proposals: Row[] }) {
  const me = useApi<Me>('/api/me', 300000);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  if (!proposals.length) return <p className="text-sm text-muted-foreground">No fix proposed yet.</p>;

  const decide = async (p: Row, decision: 'approve' | 'reject') => {
    if (decision === 'approve' && !confirm(`${actionLabel(p.action_type)}?\n\nThis changes production and is recorded under your name.${p.rollback ? `\nTo undo: ${p.rollback}` : ''}`)) return;
    setBusy(p.proposal_id);
    try {
      const r = await postJson<{ result: Row }>(`/api/proposals/${encodeURIComponent(p.proposal_id)}`, { decision, note: notes[p.proposal_id] ?? '' });
      const res = r.result ?? {};
      setMsg((m) => ({ ...m, [p.proposal_id]: res.ok ? (decision === 'approve' ? 'Done. The fix is merged and deploying.' : 'Rejected.') : `Failed: ${res.error ?? res.result?.error ?? res.result?.message ?? 'unknown error'}` }));
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
                <p className="text-sm font-medium">{actionLabel(p.action_type)}</p>
                <p className="text-xs text-muted-foreground">Proposed by {p.agent_name ?? 'the agent'} · {dayTime(p.proposed_at)}</p>
              </div>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px]">{PROPOSAL_STATUS[p.status] ?? String(p.status).replaceAll('_', ' ')}</span>
            </div>
            {p.rationale && <p className="mt-2 text-xs">{p.rationale}</p>}
            {params.pr_url && (
              <a href={params.pr_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-brand hover:underline">
                View the code change (pull request #{params.pr_number}) <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {p.requires_approval && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> <span title={p.approver_role}>Needs an approver</span>{p.rollback && <> · to undo: {p.rollback}</>}
              </p>
            )}
            {p.decided_by && <p className="mt-1 text-[11px] text-muted-foreground">{p.status === 'rejected' ? 'Rejected' : 'Approved'} by {p.decided_by} · {dayTime(p.decided_at)}</p>}
            {waiting && (
              me.data?.approver ? (
                <div className="mt-3 space-y-2">
                  <label className="sr-only" htmlFor={`note-${p.proposal_id}`}>Decision note</label>
                  <input id={`note-${p.proposal_id}`} value={notes[p.proposal_id] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [p.proposal_id]: e.target.value }))} placeholder="Note (optional, kept in the audit log)"
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs" />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy === p.proposal_id} onClick={() => decide(p, 'approve')}>{busy === p.proposal_id ? 'Working…' : 'Approve'}</Button>
                    <Button size="sm" variant="outline" disabled={busy === p.proposal_id} onClick={() => decide(p, 'reject')}>Reject</Button>
                  </div>
                </div>
              ) : (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" /> Only approvers can decide.<span className="sr-only"> Role: {p.approver_role}</span></p>
              )
            )}
            {msg[p.proposal_id] && <p className="mt-2 text-xs" role="status">{msg[p.proposal_id]}</p>}
          </li>
        );
      })}
    </ul>
  );
}
