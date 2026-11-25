'use client';

import { CHART_THEME } from '@/components/chart-utils';
import { useCursor } from '@/lib/cursor';
import { fmtMetric } from '@/lib/status';
import { hhmm, ms } from '@/lib/time';
import { Area, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';

export type SignalPoint = {
  ts: string; value: number | null; expected: number | null; expected_low: number | null; expected_high: number | null;
  is_abnormal: boolean;
};
export type Marker = { ts: string; label: string; tone?: 'change' | 'agent' | 'action' };

const TONE = { change: 'var(--chart-4)', agent: 'var(--agent)', action: 'var(--brand)' };

/**
 * Value vs expected band for one metric. Abnormal points are drawn in the
 * critical colour; markers (deploys, agent runs, actions) sit on the same axis.
 */
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

export function SignalChart({ points, unit, markers = [], window, height = 150, label, loading }: {
  points: SignalPoint[]; unit?: string; markers?: Marker[]; window?: [string, string]; height?: number; label: string; loading?: boolean;
}) {
  const cursor = useCursor();
  const raw = points.map((p) => ({
    t: ms(p.ts),
    v: num(p.value),
    band: num(p.expected_low) !== null && num(p.expected_high) !== null ? [Math.max(0, num(p.expected_low)!), num(p.expected_high)!] : null,
    exp: num(p.expected),
    bad: p.is_abnormal ? num(p.value) : null,
  })).sort((a, b) => a.t - b.t);
  // break lines where data is missing instead of drawing across the gap
  const steps = raw.slice(1).map((d, i) => d.t - raw[i].t).sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)] ?? 300000;
  const data: typeof raw = [];
  raw.forEach((d, i) => {
    if (i > 0 && d.t - raw[i - 1].t > step * 2.5) data.push({ t: raw[i - 1].t + step, v: null, band: null, exp: null, bad: null });
    data.push(d);
  });
  if (loading) return <div className="animate-pulse rounded-md bg-muted/40" style={{ height }} />;
  if (!data.length) return <div className="grid h-24 place-items-center text-xs text-muted-foreground">No data in this window</div>;
  const abnormal = points.filter((p) => p.is_abnormal).length;
  // keep only markers inside the plotted range; drop labels that would collide with the previous one
  const t0 = data[0].t, t1 = data[data.length - 1].t, gap = (t1 - t0) * 0.09;
  let lastLabelled = -Infinity;
  const shown = markers.map((m) => ({ ...m, t: ms(m.ts) })).filter((m) => m.t >= t0 && m.t <= t1).sort((a, b) => a.t - b.t)
    .map((m) => { const keep = m.t - lastLabelled > gap; if (keep) lastLabelled = m.t; return { ...m, label: keep ? m.label : '' }; });
  return (
    <figure aria-label={`${label}: ${points.length} points, ${abnormal} abnormal`}>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          onMouseMove={(s) => s && s.activeLabel !== undefined && cursor.set(Number(s.activeLabel))}
          onMouseLeave={() => cursor.set(null)}>
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t) => hhmm(new Date(t).toISOString())}
            tick={CHART_THEME.tick} axisLine={false} tickLine={false} minTickGap={40} />
          <YAxis tickFormatter={(v) => fmtMetric(v, unit)} tick={CHART_THEME.tick} axisLine={false} tickLine={false} width={56} domain={['auto', 'auto']} />
          {window && <ReferenceArea x1={ms(window[0])} x2={ms(window[1])} fill="var(--critical)" fillOpacity={0.07} ifOverflow="hidden" />}
          <Area dataKey="band" stroke="none" fill="var(--brand)" fillOpacity={0.12} isAnimationActive={false} />
          <Line dataKey="exp" stroke="var(--brand)" strokeOpacity={0.5} strokeDasharray="3 4" dot={false} isAnimationActive={false} />
          <Line dataKey="v" stroke="var(--foreground)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
          <Scatter dataKey="bad" fill="var(--critical)" isAnimationActive={false} />
          {shown.map((m, i) => (
            <ReferenceLine key={i} x={m.t} stroke={TONE[m.tone ?? 'change']} strokeDasharray="2 3" ifOverflow="discard"
              label={{ value: m.label, position: 'insideTopLeft', fill: TONE[m.tone ?? 'change'], fontSize: 10 }} />
          ))}
          {cursor.ts && <ReferenceLine x={cursor.ts} stroke="var(--muted-foreground)" strokeOpacity={0.6} />}
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              const d = active && payload?.[0]?.payload;
              if (!d) return null;
              return (
                <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-lg">
                  <div className="text-muted-foreground">{hhmm(new Date(d.t).toISOString())}</div>
                  <div className="tabular font-medium">{fmtMetric(d.v, unit)}{d.bad !== null && <span className="ml-1.5 text-critical">outside normal</span>}</div>
                  {d.band && <div className="tabular text-muted-foreground">normally {fmtMetric(d.band[0], unit)}–{fmtMetric(d.band[1], unit)}</div>}
                </div>
              );
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </figure>
  );
}
