import { STATUS_LABEL, STATUS_VAR, VERDICT_LABEL, type Status } from '@/lib/status';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, CircleDashed, OctagonAlert } from 'lucide-react';

const ICON = { healthy: CheckCircle2, warning: AlertTriangle, critical: OctagonAlert, unmonitored: CircleDashed, unknown: CircleDashed };

/** Status is always colour + icon + word, never colour alone. */
export function StatusPill({ status, className, label }: { status: Status; className?: string; label?: string }) {
  const Icon = ICON[status] ?? CircleDashed;
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', className)}
      style={{ color: STATUS_VAR[status], background: `color-mix(in oklab, ${STATUS_VAR[status]} 14%, transparent)` }}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict?: string | null }) {
  if (!verdict) return <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Not yet investigated</span>;
  const tone = verdict === 'confirmed' ? 'var(--agent)' : verdict === 'unconfirmed' ? 'var(--warning)' : 'var(--brand)';
  const label = VERDICT_LABEL[verdict] ?? verdict;
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ color: tone, background: `color-mix(in oklab, ${tone} 14%, transparent)` }}>
      {label}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center">
      <p className="font-display text-base">{title}</p>
      {children && <div className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  const access = /privilege|authorized/i.test(msg);
  return (
    <div className="rounded-lg border border-critical/40 bg-critical/5 p-5 text-sm" role="alert">
      <p className="font-medium text-critical">{access ? 'You don\u2019t have access to this data' : 'Could not load this view'}</p>
      <p className="mt-1 text-muted-foreground">
        {access ? 'Ask an admin for viewer access (role MLOPS_UI_RO), or approver access (MLOPS_APPROVER) to take actions.' : msg}
      </p>
    </div>
  );
}

/** Collapsed-by-default section for secondary detail. */
export function More({ label, children, defaultOpen }: { label: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group rounded-xl border border-border bg-card" open={defaultOpen}>
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>{label}
      </summary>
      <div className="border-t border-border p-4">{children}</div>
    </details>
  );
}
