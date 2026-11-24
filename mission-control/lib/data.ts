/**
 * Server-side data access for Mission Control. Every function reads the generic
 * control plane (MLOPS_CONTROL.CORE); nothing here knows about a specific system.
 * Values from the client are always passed as bind parameters.
 */
import { snowflake } from '@/lib/snowflake';

const CP = 'MLOPS_CONTROL.CORE';

type Row = Record<string, unknown>;

/** Lower-case keys and parse VARIANT/ARRAY JSON strings. */
function norm<T = Row>(rows: Row[]): T[] {
  return rows.map((r) => {
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) {
      let val = v;
      if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
        try {
          val = JSON.parse(v);
        } catch {
          /* keep string */
        }
      }
      o[k.toLowerCase()] = val;
    }
    return o as T;
  });
}

export async function q<T = Row>(sql: string, binds: unknown[] = []): Promise<T[]> {
  const { rows } = await snowflake.query(sql, { binds: binds as never });
  return norm<T>(rows as Row[]);
}

export async function fleet() {
  const [systems, health, incidents, runs, coverage] = await Promise.all([
    q(`SELECT system_id, name, description, owner, repo_url FROM ${CP}.SYSTEMS ORDER BY name`),
    q(`SELECT system_id, status, COUNT(*) n FROM ${CP}.V_ENTITY_HEALTH GROUP BY 1, 2`),
    q(`SELECT system_id, incident_id, title, opened_at, last_signal_at, severity, status, agent_verdict, agent_cause
       FROM ${CP}.INCIDENTS WHERE status = 'open' OR resolved_at >= DATEADD(day, -1, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
       ORDER BY status DESC, severity DESC, opened_at DESC`),
    q(`SELECT r.*, a.system_id, a.name AS agent_name FROM ${CP}.V_AGENT_RUNS r JOIN ${CP}.AGENTS a USING (agent_id)
       QUALIFY ROW_NUMBER() OVER (PARTITION BY r.agent_id ORDER BY started_at DESC) = 1`),
    q(`SELECT system_id, COUNT_IF(ARRAY_SIZE(gaps) > 0) AS entities_with_gaps, COUNT(*) AS entities FROM ${CP}.V_COVERAGE GROUP BY 1`),
  ]);
  return { systems, health, incidents, runs, coverage };
}

/** Metrics whose latest reading (last 60 min) is abnormal, across all systems. Unexplained first. */
export async function abnormalNow() {
  return q(`
    WITH latest AS (
      SELECT * FROM ${CP}.SIGNALS WHERE ts >= DATEADD(minute, -60, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY metric_id ORDER BY ts DESC) = 1
    )
    SELECT s.system_id, s.metric_id, m.name AS metric_name, m.golden_class, s.entity_id, e.name AS entity_name,
           s.ts, s.value, s.expected, s.expected_low, s.expected_high, s.severity, m.unit,
           i.incident_id, i.agent_verdict
    FROM latest s
    JOIN ${CP}.METRIC_CATALOG m ON m.metric_id = s.metric_id
    LEFT JOIN ${CP}.ENTITIES e ON e.entity_id = s.entity_id
    LEFT JOIN ${CP}.INCIDENT_SIGNALS x ON x.metric_id = s.metric_id AND x.ts = s.ts
    LEFT JOIN ${CP}.INCIDENTS i ON i.incident_id = x.incident_id
    WHERE s.is_abnormal
    ORDER BY IFF(i.agent_verdict = 'confirmed', 1, 0), s.severity DESC
    LIMIT 25`);
}

export async function system(systemId: string) {
  const [sys, entities, edges, incidents, agents, deploys] = await Promise.all([
    q(`SELECT * FROM ${CP}.SYSTEMS WHERE system_id = ?`, [systemId]),
    q(`SELECT h.* EXCLUDE (latest_metrics), h.latest_metrics::VARIANT AS latest_metrics, e.config:subtitle::STRING AS subtitle
       FROM ${CP}.V_ENTITY_HEALTH h LEFT JOIN ${CP}.ENTITIES e USING (entity_id) WHERE h.system_id = ?`, [systemId]),
    q(`SELECT from_id, to_id, relation, source FROM ${CP}.EDGES WHERE system_id = ?`, [systemId]),
    q(`SELECT * EXCLUDE (entities), entities::VARIANT AS entities FROM ${CP}.INCIDENTS WHERE system_id = ? AND (status = 'open' OR resolved_at >= DATEADD(hour, -12, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ))
       ORDER BY opened_at DESC LIMIT 5`, [systemId]),
    q(`SELECT * FROM ${CP}.AGENTS WHERE system_id = ?`, [systemId]),
    q(`SELECT entity_id, git_repo, branch, path FROM ${CP}.COMPONENT_DEPLOY WHERE system_id = ?`, [systemId]),
  ]);
  return { system: sys[0] ?? null, entities, edges, incidents, agents, deploys };
}

/** Golden-signal strip: latest value + expected range per metric for a system. */
export async function kpis(systemId: string) {
  return q(`
    SELECT m.metric_id, m.name, m.unit, m.golden_class, m.entity_id, m.description,
           s.ts, s.value, s.expected, s.expected_low, s.expected_high, s.is_abnormal, s.severity,
           (SELECT MAX(evaluated_at) FROM ${CP}.SIGNALS z WHERE z.system_id = m.system_id) AS evaluated_at
    FROM ${CP}.METRIC_CATALOG m
    LEFT JOIN ${CP}.SIGNALS s ON s.metric_id = m.metric_id
    WHERE m.system_id = ? AND m.enabled AND m.kind = 'series'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY m.metric_id ORDER BY s.ts DESC NULLS LAST) = 1
    ORDER BY ARRAY_POSITION(m.golden_class::VARIANT, ARRAY_CONSTRUCT('output','volume','freshness','data_quality','performance','reliability','cost')), m.name`,
    [systemId]);
}

/** Signal history for metrics, `hours` either side of `around` (default: the last `hours`). */
export async function series(metricIds: string[], hours: number, around?: string) {
  if (!metricIds.length) return [];
  const ph = metricIds.map(() => '?').join(',');
  const center = around ? '?::TIMESTAMP_NTZ' : 'CURRENT_TIMESTAMP()::TIMESTAMP_NTZ';
  const binds = around ? [...metricIds, hours, around, hours, around] : [...metricIds, hours, hours];
  return q(`
    SELECT metric_id, ts, value, expected, expected_low, expected_high, is_abnormal, severity, n
    FROM ${CP}.SIGNALS
    WHERE metric_id IN (${ph})
      AND ts BETWEEN DATEADD(hour, -?, ${center}) AND DATEADD(hour, ?, ${center})
    ORDER BY ts`, binds);
}

export async function incidents(systemId?: string, limit = 50) {
  return q(`SELECT i.* EXCLUDE (entities), i.entities::VARIANT AS entities, s.name AS system_name FROM ${CP}.INCIDENTS i LEFT JOIN ${CP}.SYSTEMS s USING (system_id)
            WHERE (? IS NULL OR i.system_id = ?) ORDER BY i.opened_at DESC LIMIT ${Math.min(200, Math.max(1, limit))}`,
    [systemId ?? null, systemId ?? null]);
}

export async function incident(incidentId: string) {
  const inc = (await q(`SELECT i.* EXCLUDE (entities), i.entities::VARIANT AS entities, s.name AS system_name, s.repo_url FROM ${CP}.INCIDENTS i
                         LEFT JOIN ${CP}.SYSTEMS s USING (system_id) WHERE incident_id = ?`, [incidentId]))[0];
  if (!inc) return null;
  const sys = inc.system_id as string;
  const [sigs, metrics, changes, hyps, exps, proposals, runs, entities] = await Promise.all([
    q(`SELECT metric_id, entity_id, MIN(ts) first_ts, MAX(ts) last_ts, COUNT(*) buckets, MAX(severity) max_severity
       FROM ${CP}.INCIDENT_SIGNALS WHERE incident_id = ? GROUP BY 1, 2 ORDER BY max_severity DESC`, [incidentId]),
    q(`SELECT metric_id, name, unit, golden_class, entity_id, description FROM ${CP}.METRIC_CATALOG WHERE system_id = ? AND enabled`, [sys]),
    q(`SELECT c.*, e.name AS entity_name FROM ${CP}.CHANGES c LEFT JOIN ${CP}.ENTITIES e USING (entity_id)
       WHERE c.system_id = ? AND c.changed_at BETWEEN DATEADD(hour, -6, ?::TIMESTAMP_NTZ) AND COALESCE(?::TIMESTAMP_NTZ, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
       ORDER BY changed_at`, [sys, inc.opened_at, inc.resolved_at ?? null]),
    q(`SELECT * FROM ${CP}.V_HYPOTHESES WHERE incident_id = ? ORDER BY ts`, [incidentId]),
    q(`SELECT * FROM ${CP}.V_EXPERIMENTS WHERE incident_id = ? ORDER BY ts`, [incidentId]),
    q(`SELECT * FROM ${CP}.V_PROPOSALS WHERE incident_id = ? ORDER BY proposed_at`, [incidentId]),
    q(`SELECT r.*, p.body AS report, e.attributes:subject::STRING AS report_subject, e.attributes:summary::STRING AS report_summary
       FROM ${CP}.V_AGENT_RUNS r LEFT JOIN ${CP}.AGENT_REPORTS p ON p.run_id = r.run_id
       LEFT JOIN ${CP}.AGENT_EVENTS e ON e.run_id = r.run_id AND e.kind = 'report'
       WHERE r.incident_id = ? QUALIFY ROW_NUMBER() OVER (PARTITION BY r.run_id ORDER BY e.seq DESC NULLS LAST) = 1
       ORDER BY r.started_at DESC`, [incidentId]),
    q(`SELECT entity_id, name, stage, entity_type, config:subtitle::STRING AS subtitle FROM ${CP}.ENTITIES WHERE system_id = ?`, [sys]),
  ]);
  return { incident: inc, signals: sigs, metrics, changes, hypotheses: hyps, experiments: exps, proposals, runs, entities };
}

/** Input-health heatmap: every data_quality/output metric x 5-min bucket, as deviation from expected. */
export async function heatmap(systemId: string, center: string, hours: number) {
  return q(`
    SELECT s.metric_id, m.name, m.golden_class, s.ts, s.value, s.expected, s.expected_low, s.expected_high, s.is_abnormal,
           CASE WHEN s.is_abnormal THEN LEAST(1, 0.35 + s.severity / 10)
                WHEN s.expected IS NOT NULL AND s.expected_high > s.expected
                  THEN LEAST(0.3, ABS(s.value - s.expected) / NULLIF(s.expected_high - s.expected, 0) * 0.3)
                ELSE 0 END AS intensity
    FROM ${CP}.SIGNALS s JOIN ${CP}.METRIC_CATALOG m ON m.metric_id = s.metric_id
    WHERE s.system_id = ? AND s.ts BETWEEN DATEADD(hour, -?, ?::TIMESTAMP_NTZ) AND DATEADD(hour, ?, ?::TIMESTAMP_NTZ)
    ORDER BY m.golden_class, m.name, s.ts`, [systemId, hours, center, hours, center]);
}

export async function slices(entityId: string, start: string, end: string) {
  return q(`CALL ${CP}.SLICE_EXCESS(?, ?::TIMESTAMP_NTZ, ?::TIMESTAMP_NTZ)`, [entityId, start, end]);
}

export async function agentRuns(limit = 30) {
  return q(`SELECT r.*, a.name AS agent_name, a.system_id FROM ${CP}.V_AGENT_RUNS r JOIN ${CP}.AGENTS a USING (agent_id)
            ORDER BY started_at DESC LIMIT ${Math.min(200, Math.max(1, limit))}`);
}

export async function agentRun(runId: string) {
  const [events, agent, proposals] = await Promise.all([
    q(`SELECT seq, ts, kind, name, status, entity_id, incident_id, attributes FROM ${CP}.AGENT_EVENTS WHERE run_id = ? ORDER BY seq`, [runId]),
    q(`SELECT a.*, r.started_at, r.ended_at, r.last_event_at, r.verdict, r.status_line, r.trigger_type, r.incident_id,
              CURRENT_TIMESTAMP()::TIMESTAMP_NTZ AS now_ts
       FROM ${CP}.V_AGENT_RUNS r JOIN ${CP}.AGENTS a USING (agent_id) WHERE r.run_id = ?`, [runId]),
    q(`SELECT * FROM ${CP}.V_PROPOSALS WHERE run_id = ? ORDER BY seq`, [runId]),
  ]);
  const report = (await q(`SELECT body FROM ${CP}.AGENT_REPORTS WHERE run_id = ?`, [runId]))[0]?.body ?? null;
  const run = agent[0] ?? null;
  const topo = run
    ? await Promise.all([
        q(`SELECT h.entity_id, h.name, h.stage, h.entity_type, h.status, e.config:subtitle::STRING AS subtitle
            FROM ${CP}.V_ENTITY_HEALTH h LEFT JOIN ${CP}.ENTITIES e USING (entity_id) WHERE h.system_id = ?`, [run.system_id]),
        q(`SELECT from_id, to_id, relation FROM ${CP}.EDGES WHERE system_id = ?`, [run.system_id]),
      ])
    : [[], []];
  return { run, events, proposals, report, entities: topo[0], edges: topo[1] };
}

export async function agents() {
  return q(`SELECT a.*, s.name AS system_name FROM ${CP}.AGENTS a LEFT JOIN ${CP}.SYSTEMS s USING (system_id) ORDER BY a.name`);
}

export async function governance() {
  const [log, accuracy, mttx, coverage, policy, names] = await Promise.all([
    q(`SELECT * FROM ${CP}.ACTION_LOG ORDER BY ts DESC LIMIT 100`),
    q(`SELECT system_id, ANY_VALUE(s.name) system_name, COUNT(*) incidents, COUNT(agent_verdict) investigated, COUNT(human_verdict) reviewed,
              COUNT_IF(human_verdict = 'correct') correct, COUNT_IF(human_verdict = 'partially_correct') partial,
              COUNT_IF(human_verdict = 'wrong') wrong, COUNT_IF(human_verdict = 'not_an_incident') false_alarm
       FROM ${CP}.INCIDENTS LEFT JOIN ${CP}.SYSTEMS s USING (system_id) GROUP BY 1`),
    q(`SELECT i.system_id, ANY_VALUE(s.name) system_name, i.incident_id, ANY_VALUE(i.title) title, i.opened_at, i.resolved_at,
              MIN(r.started_at) first_agent_at, MIN(IFF(l.outcome = 'executed' AND l.action LIKE 'approve:%', l.ts, NULL)) mitigated_at
       FROM ${CP}.INCIDENTS i LEFT JOIN ${CP}.SYSTEMS s USING (system_id) LEFT JOIN ${CP}.V_AGENT_RUNS r ON r.incident_id = i.incident_id
       LEFT JOIN ${CP}.ACTION_LOG l ON l.incident_id = i.incident_id
       GROUP BY i.system_id, i.incident_id, i.opened_at, i.resolved_at ORDER BY i.opened_at DESC LIMIT 50`),
    q(`SELECT c.* EXCLUDE (gaps), c.gaps::VARIANT AS gaps, s.name AS system_name FROM ${CP}.V_COVERAGE c LEFT JOIN ${CP}.SYSTEMS s USING (system_id)
       ORDER BY ARRAY_SIZE(c.gaps) DESC, c.system_id, c.stage`),
    q(`SELECT * FROM ${CP}.ACTION_TYPES ORDER BY requires_approval DESC, action_type`),
    q(`SELECT entity_id, name FROM ${CP}.ENTITIES UNION ALL SELECT agent_id, name FROM ${CP}.AGENTS`),
  ]);
  return { log, accuracy, mttx, coverage, policy, names };
}

export async function freshness() {
  const rows = await q(`SELECT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ AS now_ts,
                          (SELECT MAX(evaluated_at) FROM ${CP}.SIGNALS) AS signals_at,
                          (SELECT MAX(loaded_at) FROM ${CP}.AGENT_EVENTS) AS events_at,
                          TO_CHAR(CURRENT_TIMESTAMP(), 'TZH:TZM') AS tz`);
  return rows[0];
}
