/** State vocabulary shared by every screen. Colour is reserved for state. */
export type Status = 'healthy' | 'warning' | 'critical' | 'unmonitored' | 'unknown';

export const STATUS_LABEL: Record<Status, string> = {
  healthy: 'Healthy',
  warning: 'Degraded',
  critical: 'Critical',
  unmonitored: 'Not monitored',
  unknown: 'No data',
};

/** CSS variable per status, for both Tailwind (via style) and three.js materials. */
export const STATUS_VAR: Record<Status, string> = {
  healthy: 'var(--brand)',
  warning: 'var(--warning)',
  critical: 'var(--critical)',
  unmonitored: 'var(--muted-foreground)',
  unknown: 'var(--muted-foreground)',
};

/** Left-to-right order of the flow: data in, feature store, build inputs, run scoring, model, decide. */
export const STAGE_ORDER = ['source', 'feature_store', 'feature', 'serving', 'model', 'decision', 'orchestration', 'agent'];
export const STAGE_LABEL: Record<string, string> = {
  source: 'Data in', feature_store: 'Feature Store', feature: 'Model inputs', serving: 'Scoring', model: 'Model',
  decision: 'Results', orchestration: 'Orchestration', agent: 'Agents',
};

/** What the agent concluded about an incident. */
export const VERDICT_LABEL: Record<string, string> = {
  confirmed: 'Agent: cause found',
  unconfirmed: 'Agent: cause not proven',
  healthy: 'Agent: no problem found',
};

/** What an engineer said about the agent. Same words in buttons, badges and Governance. */
export const HUMAN_VERDICT_LABEL: Record<string, string> = {
  correct: 'Right',
  partially_correct: 'Partly right',
  wrong: 'Wrong',
  not_an_incident: 'Not a real incident',
};

export const ACTION_LABEL: Record<string, string> = {
  merge_pr: 'Merge the fix',
  open_pr: 'Open a fix (pull request)',
  rollback_model_default: 'Roll back the model',
  set_feature_set: 'Switch back to a previous feature set',
  suspend_task: 'Pause a scheduled job',
  page_oncall: 'Alert the on-call engineer',
  escalate: 'Alert the on-call engineer',
  close_pr: 'Close the pull request',
};
export const actionLabel = (t?: string) => (t ? ACTION_LABEL[t] ?? t.replaceAll('_', ' ') : '');

/** Audit-log actions are `verb[:detail]`; turn them into words. */
export function auditLabel(a?: string): string {
  if (!a) return '';
  const [verb, rest] = a.split(':');
  const words: Record<string, string> = {
    approve: 'Approved', reject: 'Rejected', run_agent: 'Started agent run', deploy: 'Deployed',
    verdict: 'Graded the agent', execute: 'Ran',
  };
  const head = words[verb] ?? verb.replaceAll('_', ' ');
  return rest ? `${head}: ${ACTION_LABEL[rest] ?? HUMAN_VERDICT_LABEL[rest] ?? rest.replaceAll('_', ' ')}` : head;
}

export const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Started by a person', schedule: 'Scheduled', scheduled: 'Scheduled', incident: 'Incident opened', alert: 'Alert',
};
export const triggerLabel = (t?: string) => (t ? TRIGGER_LABEL[t] ?? t.replaceAll('_', ' ') : 'Unknown');

export function severityLabel(s: unknown): 'Low' | 'Medium' | 'High' {
  const n = Number(s);
  return n >= 4 ? 'High' : n >= 2 ? 'Medium' : 'Low';
}

/** Agent tool and step names, in words. Unknown names are de-snaked. */
const STEP_LABEL: Record<string, string> = {
  counterfactual: 'Ran a what-if test', fraud_rate_anomaly: 'Checked the flag rate', spike_breakdown: 'Broke the spike down by segment',
  control_plane_incidents: 'Read the open incident', incidents: 'Read the open incident', feature_health: 'Checked model inputs',
  dmf_results: 'Checked data-quality results', recent_changes: 'Checked recent changes', lineage: 'Traced where data comes from',
  github: 'Worked on GitHub', git: 'Prepared the code change', hypotheses: 'Listed possible causes',
  detect: 'Checked for problems', scope: 'Worked out what is affected', evidence: 'Gathered evidence',
  remediate: 'Prepared a fix', verify: 'Checked the fix', report: 'Wrote the report',
};
export function stepLabel(name?: string): string {
  if (!name) return 'Step';
  return STEP_LABEL[name.toLowerCase()] ?? name.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export const GAP_LABEL: Record<string, string> = {
  'no monitors': 'No health checks',
  'no lineage': 'Unknown upstream data',
  'no deploy hook': 'Fixes can’t be deployed automatically',
  'not replayable (no counterfactual)': 'Can’t run what-if tests',
};

export const PROPOSAL_STATUS: Record<string, string> = {
  proposed: 'Waiting for approval', awaiting_approval: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected',
  executed: 'Done', executed_by_agent: 'Done by agent', failed: 'Failed',
};

export function fmtMetric(v: unknown, unit?: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (unit) {
    case 'share':
      return `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;
    case 'ratio':
      return `${n.toFixed(2)}×`;
    case 'pct':
      return `${n.toFixed(n < 10 ? 1 : 0)}%`;
    case 'minutes':
      return `${Math.round(n)} min`;
    case 'km':
      return `${n.toFixed(n < 10 ? 1 : 0)} km`;
    case 'txns/5m':
    case 'rows/5m':
      return `${Math.round(n).toLocaleString()} / 5 min`;
    default:
      if (Number.isInteger(n)) return n.toLocaleString();
      return Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : n.toFixed(Math.abs(n) < 1 ? 3 : 2);
  }
}

/** "normally 0.5–1.2%" / "normally ≤ 1%" / "normally ≥ 40". */
export function normalRange(k: Record<string, any>): string {
  const u = k.unit;
  if (k.expected_low !== null && k.expected_low !== undefined && k.expected_high !== null && k.expected_high !== undefined)
    return `normally ${fmtMetric(Math.max(0, Number(k.expected_low)), u)}–${fmtMetric(k.expected_high, u)}`;
  if (k.expected_high !== null && k.expected_high !== undefined) return `normally ≤ ${fmtMetric(k.expected_high, u)}`;
  if (k.expected_low !== null && k.expected_low !== undefined) return `normally ≥ ${fmtMetric(k.expected_low, u)}`;
  if (k.expected !== null && k.expected !== undefined) return `normally ${fmtMetric(k.expected, u)}`;
  return '';
}

/** Correlator titles read "Abnormal X, Y"; show them as "Unusual X, Y". */
export const incidentTitle = (t?: string) => (t ?? 'Incident').replace(/^Abnormal\s+/i, 'Unusual: ');

/** "pipeline_version V1" -> "Switch the pipeline back to V1"; "input_asof <ts>" -> "Use source data as of <ts>". */
export function interventionLabel(x?: string, names: Record<string, string> = {}): string {
  if (!x) return 'What-if test';
  const [kind, ...rest] = x.split(' ');
  const v = rest.join(' ');
  if (kind === 'input_asof') return `Use source data as it was at ${v.slice(11, 16) || v}`;
  const what = kind.replace(/_version$/, '');
  const name = names[what] ?? what.replaceAll('_', ' ');
  return `Switch ${name} back to ${v}`;
}

export const dimLabel = (d: string) => d.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Drop commit hashes and the like from free text, e.g. "Feature pipeline V2 (7e77f46)". */
export const stripRefs = (t?: string) => (t ?? '').replace(/\s*\(?\b[0-9a-f]{7,40}\b\)?/g, '').trim();

/**
 * Agents end with a machine status line, e.g.
 * "X_INCIDENT cause=feature_pipeline:V2 confirmed=true excess_flags=23 pr=https://…/pull/8".
 * Turn it into a sentence; fall back to the raw text when it isn't key=value shaped.
 */
export function runSummary(line?: string | null, verdict?: string | null): string {
  if (!line) return verdict ? VERDICT_LABEL[verdict] ?? '' : '';
  const kv = Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  if (!Object.keys(kv).length) return line;
  const parts: string[] = [];
  if (kv.cause) {
    const [what, ver] = kv.cause.split(':');
    parts.push(`${kv.confirmed === 'false' ? 'Suspected cause' : 'Cause found'}: ${what.replaceAll('_', ' ')}${ver ? ` ${ver}` : ''}`);
  } else if (verdict === 'healthy' || /_OK\b/.test(line)) {
    parts.push('No problem found');
  }
  if (kv.excess_flags) parts.push(`${kv.excess_flags} extra transactions flagged`);
  if (kv.flag_rate) parts.push(`flag rate ${(Number(kv.flag_rate) * 100).toFixed(1)}%${kv.baseline ? ` (normally ${(Number(kv.baseline) * 100).toFixed(1)}%)` : ''}`);
  const pr = kv.pr?.match(/\/pull\/(\d+)/)?.[1];
  if (pr) parts.push(`fix proposed (pull request #${pr})`);
  return parts.length ? parts.join(' · ') : line;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
