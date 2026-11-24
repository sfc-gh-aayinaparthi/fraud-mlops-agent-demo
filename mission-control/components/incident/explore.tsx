'use client';

import { Button } from '@/components/ui/button';
import { postJson } from '@/lib/client';
import { useState } from 'react';

type Row = Record<string, unknown>;

/**
 * Read-only exploration for the engineer: one SELECT, run with their own
 * Snowflake privileges. Starter queries are scoped to the incident window.
 */
export function Explore({ templates }: { templates: { label: string; sql: string }[] }) {
  const [sql, setSql] = useState(templates[0]?.sql ?? '');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      setRows((await postJson<{ rows: Row[] }>('/api/explore', { sql })).rows);
    } catch (e) {
      setErr((e as Error).message); setRows(null);
    } finally {
      setBusy(false);
    }
  };
  const cols = rows?.length ? Object.keys(rows[0]) : [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {templates.map((t) => (
          <button key={t.label} onClick={() => setSql(t.sql)} className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-brand/60 hover:text-foreground">
            {t.label}
          </button>
        ))}
      </div>
      <label htmlFor="explore-sql" className="sr-only">SQL</label>
      <textarea id="explore-sql" value={sql} onChange={(e) => setSql(e.target.value)} rows={6} spellCheck={false}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run(); }}
        className="w-full rounded-md border border-input bg-background p-2.5 font-mono text-[12px] leading-relaxed" />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run query'}</Button>
        <span className="text-[11px] text-muted-foreground">Read-only · uses your own access · up to 500 rows · Ctrl/⌘+Enter to run</span>
      </div>
      {err && <p className="text-xs text-critical" role="alert">{err}</p>}
      {rows && (
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-muted"><tr>{cols.map((c) => <th key={c} className="px-2 py-1 text-left font-medium">{c.toLowerCase()}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">{cols.map((c) => <td key={c} className="tabular whitespace-nowrap px-2 py-1">{String(r[c] ?? '—')}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="p-3 text-xs text-muted-foreground">No rows.</p>}
        </div>
      )}
    </div>
  );
}
