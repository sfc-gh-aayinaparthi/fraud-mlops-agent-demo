'use client';

import { ThemeToggle } from '@/components/theme-toggle';
import { useApi } from '@/lib/client';
import { ago, ms } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Bot, Radar, ShieldCheck, Siren } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type React from 'react';

const NAV = [
  { href: '/', label: 'Fleet', icon: Radar, match: (p: string) => p === '/' || p.startsWith('/systems') },
  { href: '/incidents', label: 'Incidents', icon: Siren, match: (p: string) => p.startsWith('/incidents') },
  { href: '/agents', label: 'Agents', icon: Bot, match: (p: string) => p.startsWith('/agents') },
  { href: '/governance', label: 'Governance', icon: ShieldCheck, match: (p: string) => p.startsWith('/governance') },
];

type Fresh = { freshness?: { now_ts: string; signals_at: string; events_at: string } };
type Me = { user: string | null; approver: boolean; identity: 'caller' | 'dev' };

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const fleet = useApi<Fresh>('/api/fleet', 30000);
  const me = useApi<Me>('/api/me', 300000);
  const f = fleet.data?.freshness;
  const stale = f ? (ms(f.now_ts) - ms(f.signals_at)) / 60000 > 12 : false;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-6 px-5">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Mission Control home">
            <span className="relative grid h-7 w-7 place-items-center rounded-md bg-brand/15 ring-1 ring-brand/40">
              <span className="h-2 w-2 rounded-full bg-brand" />
            </span>
            <span className="font-display text-[15px] font-semibold tracking-tight">Mission Control</span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="Primary">
            {NAV.map(({ href, label, icon: Icon, match }) => (
              <Link
                key={href}
                href={href}
                aria-current={match(path) ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  match(path) && 'bg-accent text-foreground',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
            {f && (
              <span className={cn('hidden items-center gap-1.5 md:flex', stale && 'text-warning')} title="When the control plane last evaluated signals">
                <span className={cn('h-1.5 w-1.5 rounded-full', stale ? 'bg-warning' : 'bg-brand')} />
                Signals {ago(f.signals_at, f.now_ts)}
                {stale && ' (stale)'}
              </span>
            )}
            {me.data?.user && (
              <span className="hidden items-center gap-1.5 lg:flex" title={me.data.identity === 'dev' ? 'Local dev: actions run as the developer connection' : 'Signed-in Snowflake user'}>
                {me.data.user}
                <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', me.data.approver ? 'bg-agent/15 text-agent' : 'bg-muted')}>
                  {me.data.approver ? 'Approver' : 'Viewer'}
                </span>
              </span>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1480px] flex-1 px-5 pb-16 pt-6">{children}</main>
    </div>
  );
}
