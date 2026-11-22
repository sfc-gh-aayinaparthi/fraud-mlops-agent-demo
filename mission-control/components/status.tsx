import { STATUS_LABEL, STATUS_VAR, type Status } from '@/lib/status';
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
  const label = verdict === 'confirmed' ? 'Agent: cause confirmed' : verdict === 'unconfirmed' ? 'Agent: cause unconfirmed' : 'Agent: healthy';
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
        {access ? 'Ask an admin to grant the MLOPS_UI_RO role (read) or MLOPS_APPROVER (actions).' : msg}
      </p>
    </div>
  );
}
