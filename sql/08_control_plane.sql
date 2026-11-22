-- 08 Generic MLOps control plane.
-- Knows only entity TYPES (systems, components, metrics, signals, incidents, changes,
-- agent events, action proposals). Anything system-specific is a configuration row
-- (see 09_seed_<system>.sql).
USE ROLE ACCOUNTADMIN;
CREATE DATABASE IF NOT EXISTS MLOPS_CONTROL COMMENT = 'Agentic MLOps control plane';
CREATE SCHEMA IF NOT EXISTS MLOPS_CONTROL.CORE;
USE SCHEMA MLOPS_CONTROL.CORE;
USE WAREHOUSE FRAUD_WH;

---------------------------------------------------------------------------- registry
CREATE TABLE IF NOT EXISTS SYSTEMS (
  system_id STRING PRIMARY KEY, name STRING, description STRING, owner STRING,
  repo_url STRING, agent_task STRING, config VARIANT,
  created_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);

-- stage: source | feature | model | serving | decision | orchestration | agent
CREATE TABLE IF NOT EXISTS ENTITIES (
  entity_id STRING PRIMARY KEY, system_id STRING, entity_type STRING, name STRING,
  fqn STRING, stage STRING, owner STRING, config VARIANT);

CREATE TABLE IF NOT EXISTS EDGES (
  system_id STRING, from_id STRING, to_id STRING, relation STRING,
  source STRING DEFAULT 'manual');

------------------------------------------------------------------- metrics -> signals
-- kind = series : source_sql returns (ts, value[, n]) for ':START' <= ts < ':END';
--                 expected range computed by expected_method:
--                   same_hour_baseline {lookback_days, k, min_abs_delta, min_ratio}
--                   static             {low, high}
-- kind = event  : source_sql returns abnormal rows (ts, value, detail) in the window.
CREATE TABLE IF NOT EXISTS METRIC_CATALOG (
  metric_id STRING PRIMARY KEY, system_id STRING, entity_id STRING, name STRING,
  unit STRING, golden_class STRING,   -- volume|output|data_quality|freshness|performance|reliability|cost
  kind STRING, source_sql STRING, expected_method STRING, params VARIANT,
  direction STRING DEFAULT 'both',    -- high|low|both : which deviation is abnormal
  enabled BOOLEAN DEFAULT TRUE, description STRING);

CREATE TABLE IF NOT EXISTS SIGNALS (
  metric_id STRING, system_id STRING, entity_id STRING, ts TIMESTAMP_NTZ,
  value FLOAT, n FLOAT, expected FLOAT, expected_low FLOAT, expected_high FLOAT,
  is_abnormal BOOLEAN, severity FLOAT, detail STRING,
  evaluated_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);

-- change feeds: source_sql returns (changed_at, entity_id, change_type, summary,
-- version, previous_version, ref, author) for ':START' <= changed_at < ':END'
CREATE TABLE IF NOT EXISTS CHANGE_SOURCES (
  source_id STRING PRIMARY KEY, system_id STRING, name STRING, source_sql STRING,
  enabled BOOLEAN DEFAULT TRUE);

CREATE TABLE IF NOT EXISTS CHANGES (
  change_key STRING, system_id STRING, source_id STRING, entity_id STRING,
  changed_at TIMESTAMP_NTZ, change_type STRING, summary STRING, version STRING,
  previous_version STRING, ref STRING, author STRING);

---------------------------------------------------------------------- slice analysis
-- per model: a feature/prediction log and candidate slice dimensions
CREATE TABLE IF NOT EXISTS SLICE_CONFIG (
  system_id STRING, entity_id STRING, log_sql STRING,   -- returns ts, outcome (0/1 or numeric), dims...
  dimensions ARRAY, outcome_label STRING);

---------------------------------------------------------------------------- incidents
CREATE TABLE IF NOT EXISTS INCIDENTS (
  incident_id STRING PRIMARY KEY, system_id STRING, status STRING,  -- open|resolved
  title STRING, opened_at TIMESTAMP_NTZ, last_signal_at TIMESTAMP_NTZ,
  resolved_at TIMESTAMP_NTZ, severity FLOAT, entities ARRAY,
  agent_verdict STRING, agent_cause STRING, agent_run_id STRING,
  human_verdict STRING, human_note STRING, human_by STRING, human_at TIMESTAMP_NTZ);

CREATE TABLE IF NOT EXISTS INCIDENT_SIGNALS (
  incident_id STRING, metric_id STRING, entity_id STRING, ts TIMESTAMP_NTZ, severity FLOAT);

---------------------------------------------------------------------- agents & actions
CREATE TABLE IF NOT EXISTS AGENTS (
  agent_id STRING PRIMARY KEY, system_id STRING, name STRING, task_fqn STRING,
  restricted_scope STRING, trace_path STRING, description STRING);

-- span-style events emitted by agents (loaded from their trace files)
CREATE TABLE IF NOT EXISTS AGENT_EVENTS (
  agent_id STRING, run_id STRING, seq NUMBER, ts TIMESTAMP_NTZ, kind STRING,
  -- run_start|step|tool|hypothesis|experiment|proposal|report|run_end
  name STRING, status STRING, entity_id STRING, incident_id STRING,
  attributes VARIANT, source_file STRING,
  loaded_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);

CREATE TABLE IF NOT EXISTS ACTION_TYPES (
  action_type STRING PRIMARY KEY, description STRING, executor STRING,
  -- executor: github_merge_pr | github_close_pr | sql_procedure | escalate
  requires_approval BOOLEAN, approver_role STRING, rollback STRING);

CREATE TABLE IF NOT EXISTS ACTION_PROPOSALS (
  proposal_id STRING PRIMARY KEY, system_id STRING, incident_id STRING,
  agent_id STRING, run_id STRING, action_type STRING, params VARIANT,
  rationale STRING, status STRING,   -- proposed|approved|rejected|executed|failed
  proposed_at TIMESTAMP_NTZ, decided_by STRING, decided_at TIMESTAMP_NTZ, result STRING);

CREATE TABLE IF NOT EXISTS ACTION_LOG (
  log_id STRING DEFAULT UUID_STRING(), ts TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  actor STRING, action STRING, target STRING, system_id STRING, incident_id STRING,
  proposal_id STRING, details VARIANT, outcome STRING);

-- component deploy hooks (generic Git -> Snowflake CD)
CREATE TABLE IF NOT EXISTS COMPONENT_DEPLOY (
  entity_id STRING PRIMARY KEY, system_id STRING, git_repo STRING, branch STRING,
  path STRING, version_regex STRING, deploy_procedure STRING, active_version_sql STRING);

--------------------------------------------------------------------------- evaluation
-- Evaluate every enabled metric for [now - lookback, now) and upsert SIGNALS.
CREATE OR REPLACE PROCEDURE EVALUATE_METRICS(LOOKBACK_MINUTES NUMBER DEFAULT 60)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
EXECUTE AS CALLER
AS
$$
import datetime as dt
import json
import statistics

def window_sql(src, s, e):
    return src.replace(":START", f"'{s}'::TIMESTAMP_NTZ").replace(":END", f"'{e}'::TIMESTAMP_NTZ")

def run(session, lookback_minutes):
    session.sql("USE SCHEMA MLOPS_CONTROL.CORE").collect()   # temp staging table needs a current schema
    now = session.sql("SELECT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ").collect()[0][0]
    start = now - dt.timedelta(minutes=int(lookback_minutes))
    metrics = session.sql("SELECT * FROM MLOPS_CONTROL.CORE.METRIC_CATALOG WHERE enabled").collect()
    out, errors = [], []
    for m in metrics:
        p = json.loads(m["PARAMS"]) if m["PARAMS"] else {}
        try:
            if m["KIND"] == "event":
                for r in session.sql(window_sql(m["SOURCE_SQL"], start, now)).collect():
                    out.append((m["METRIC_ID"], m["SYSTEM_ID"], m["ENTITY_ID"], r[0], float(r[1] or 1),
                                None, None, None, None, True, float(p.get("severity", 3)),
                                str(r[2]) if len(r) > 2 else None))
                continue
            cur = session.sql(window_sql(m["SOURCE_SQL"], start, now)).collect()
            if not cur:
                continue
            base = {}
            if m["EXPECTED_METHOD"] == "same_hour_baseline":
                days = int(p.get("lookback_days", 7))
                hist = session.sql(window_sql(m["SOURCE_SQL"], now - dt.timedelta(days=days),
                                              now - dt.timedelta(hours=int(p.get("exclude_recent_hours", 6))))).collect()
                for r in hist:
                    if r[1] is not None:
                        base.setdefault(r[0].hour, []).append(float(r[1]))
            for r in cur:
                ts, v = r[0], r[1]
                n = float(r[2]) if len(r) > 2 and r[2] is not None else None
                if v is None:
                    continue
                v = float(v)
                if n is not None and n < float(p.get("min_n", 0)):
                    continue
                if m["EXPECTED_METHOD"] == "static":
                    lo, hi = p.get("low"), p.get("high")
                    exp = None
                else:
                    vals = base.get(ts.hour, [])
                    if len(vals) < 3:
                        continue
                    exp = statistics.mean(vals)
                    sd = statistics.pstdev(vals) or 1e-9
                    k = float(p.get("k", 4))
                    lo, hi = exp - k * sd, exp + k * sd
                    mad = float(p.get("min_abs_delta", 0))
                    lo, hi = min(lo, exp - mad), max(hi, exp + mad)
                    if "min_ratio" in p:
                        hi = max(hi, exp * float(p["min_ratio"]))
                        lo = min(lo, exp / float(p["min_ratio"]))
                d = m["DIRECTION"] or "both"
                high = hi is not None and v > hi and d in ("high", "both")
                low = lo is not None and v < lo and d in ("low", "both")
                ab = bool(high or low)
                sev = 0.0
                if ab:
                    ref = hi if high else lo
                    scale = abs(ref - exp) if exp is not None else max(abs(ref), 1.0)
                    sev = round(min(10.0, 1 + abs(v - ref) / (scale or 1e-9)), 2)
                out.append((m["METRIC_ID"], m["SYSTEM_ID"], m["ENTITY_ID"], ts, v, n, exp, lo, hi, ab, sev, None))
        except Exception as ex:
            errors.append(f"{m['METRIC_ID']}: {str(ex)[:200]}")
    if out:
        cols = ["METRIC_ID", "SYSTEM_ID", "ENTITY_ID", "TS", "VALUE", "N", "EXPECTED", "EXPECTED_LOW",
                "EXPECTED_HIGH", "IS_ABNORMAL", "SEVERITY", "DETAIL"]
        from snowflake.snowpark.types import StructType, StructField, StringType, FloatType, TimestampType, BooleanType
        types = [StringType(), StringType(), StringType(), TimestampType(), FloatType(), FloatType(), FloatType(),
                 FloatType(), FloatType(), BooleanType(), FloatType(), StringType()]
        fl = lambda x: None if x is None else float(x)
        rows = [(r[0], r[1], r[2], r[3], fl(r[4]), fl(r[5]), fl(r[6]), fl(r[7]), fl(r[8]), r[9], fl(r[10]), r[11]) for r in out]
        df = session.create_dataframe(rows, schema=StructType([StructField(c, t) for c, t in zip(cols, types)]))
        df.write.save_as_table("MLOPS_CONTROL.CORE.SIGNALS_STAGING", mode="overwrite", table_type="temporary")
        session.sql("""
          MERGE INTO MLOPS_CONTROL.CORE.SIGNALS t USING MLOPS_CONTROL.CORE.SIGNALS_STAGING s
            ON t.metric_id = s.metric_id AND t.ts = s.ts
          WHEN MATCHED THEN UPDATE SET value = s.value, n = s.n, expected = s.expected,
               expected_low = s.expected_low, expected_high = s.expected_high,
               is_abnormal = s.is_abnormal, severity = s.severity, detail = s.detail,
               evaluated_at = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
          WHEN NOT MATCHED THEN INSERT (metric_id, system_id, entity_id, ts, value, n, expected,
               expected_low, expected_high, is_abnormal, severity, detail)
               VALUES (s.metric_id, s.system_id, s.entity_id, s.ts, s.value, s.n, s.expected,
               s.expected_low, s.expected_high, s.is_abnormal, s.severity, s.detail)""").collect()
    return f"metrics={len(metrics)} signals={len(out)} errors={errors}"
$$;

-- Pull every registered change feed for [now - lookback, now)
CREATE OR REPLACE PROCEDURE SYNC_CHANGES(LOOKBACK_MINUTES NUMBER DEFAULT 1440)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
EXECUTE AS CALLER
AS
$$
import datetime as dt

def run(session, lookback_minutes):
    now = session.sql("SELECT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ").collect()[0][0]
    s = now - dt.timedelta(minutes=int(lookback_minutes))
    n, errors = 0, []
    for src in session.sql("SELECT * FROM MLOPS_CONTROL.CORE.CHANGE_SOURCES WHERE enabled").collect():
        q = src["SOURCE_SQL"].replace(":START", f"'{s}'::TIMESTAMP_NTZ").replace(":END", f"'{now}'::TIMESTAMP_NTZ")
        try:
            session.sql(f"""
              MERGE INTO MLOPS_CONTROL.CORE.CHANGES t
              USING (SELECT MD5(CONCAT_WS('|', '{src['SOURCE_ID']}', c.$1::STRING, COALESCE(c.$2::STRING,''),
                                COALESCE(c.$3::STRING,''), COALESCE(c.$5::STRING,''), COALESCE(c.$7::STRING,''))) AS change_key,
                            '{src['SYSTEM_ID']}' AS system_id, '{src['SOURCE_ID']}' AS source_id,
                            c.$2::STRING AS entity_id, c.$1::TIMESTAMP_NTZ AS changed_at, c.$3::STRING AS change_type,
                            c.$4::STRING AS summary, c.$5::STRING AS version, c.$6::STRING AS previous_version,
                            c.$7::STRING AS ref, c.$8::STRING AS author
                     FROM ({q}) c) x
              ON t.change_key = x.change_key
              WHEN NOT MATCHED THEN INSERT VALUES (x.change_key, x.system_id, x.source_id, x.entity_id,
                   x.changed_at, x.change_type, x.summary, x.version, x.previous_version, x.ref, x.author)""").collect()
            n += 1
        except Exception as ex:
            errors.append(f"{src['SOURCE_ID']}: {str(ex)[:200]}")
    return f"sources_synced={n} errors={errors}"
$$;

-- Group abnormal signals into incidents (per system, time-adjacent); resolve when quiet.
CREATE OR REPLACE PROCEDURE CORRELATE_INCIDENTS(GAP_MINUTES NUMBER DEFAULT 30, QUIET_MINUTES NUMBER DEFAULT 15)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  attached NUMBER DEFAULT 0;
  opened NUMBER DEFAULT 0;
  resolved NUMBER DEFAULT 0;
BEGIN
  -- 1. attach new abnormal signals to an open incident of the same system
  INSERT INTO MLOPS_CONTROL.CORE.INCIDENT_SIGNALS
  SELECT i.incident_id, s.metric_id, s.entity_id, s.ts, s.severity
  FROM MLOPS_CONTROL.CORE.SIGNALS s
  JOIN MLOPS_CONTROL.CORE.INCIDENTS i
    ON i.system_id = s.system_id AND i.status = 'open'
   AND s.ts >= DATEADD(minute, -:GAP_MINUTES, i.opened_at)
   AND s.ts <= DATEADD(minute, :GAP_MINUTES, i.last_signal_at)
  WHERE s.is_abnormal
    AND NOT EXISTS (SELECT 1 FROM MLOPS_CONTROL.CORE.INCIDENT_SIGNALS x
                    WHERE x.metric_id = s.metric_id AND x.ts = s.ts);
  attached := SQLROWCOUNT;

  -- 2. open a new incident per system for remaining recent abnormal signals
  INSERT INTO MLOPS_CONTROL.CORE.INCIDENTS
    (incident_id, system_id, status, title, opened_at, last_signal_at, severity, entities)
  SELECT UUID_STRING(), s.system_id, 'open',
         'Abnormal ' || LISTAGG(DISTINCT m.name, ', ') WITHIN GROUP (ORDER BY m.name),
         MIN(s.ts), MAX(s.ts), MAX(s.severity), ARRAY_AGG(DISTINCT s.entity_id)
  FROM MLOPS_CONTROL.CORE.SIGNALS s
  JOIN MLOPS_CONTROL.CORE.METRIC_CATALOG m ON m.metric_id = s.metric_id
  WHERE s.is_abnormal AND s.ts >= DATEADD(hour, -6, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
    AND NOT EXISTS (SELECT 1 FROM MLOPS_CONTROL.CORE.INCIDENT_SIGNALS x
                    WHERE x.metric_id = s.metric_id AND x.ts = s.ts)
  GROUP BY s.system_id;
  opened := SQLROWCOUNT;

  INSERT INTO MLOPS_CONTROL.CORE.INCIDENT_SIGNALS
  SELECT i.incident_id, s.metric_id, s.entity_id, s.ts, s.severity
  FROM MLOPS_CONTROL.CORE.SIGNALS s
  JOIN MLOPS_CONTROL.CORE.INCIDENTS i
    ON i.system_id = s.system_id AND i.status = 'open'
   AND s.ts BETWEEN i.opened_at AND i.last_signal_at
  WHERE s.is_abnormal
    AND NOT EXISTS (SELECT 1 FROM MLOPS_CONTROL.CORE.INCIDENT_SIGNALS x
                    WHERE x.metric_id = s.metric_id AND x.ts = s.ts);

  -- 3. refresh incident rollups
  UPDATE MLOPS_CONTROL.CORE.INCIDENTS i SET
    last_signal_at = a.last_ts, severity = a.sev, entities = a.ents,
    title = 'Abnormal ' || a.names
  FROM (SELECT x.incident_id, MAX(x.ts) last_ts, MAX(x.severity) sev,
               ARRAY_AGG(DISTINCT x.entity_id) ents,
               LISTAGG(DISTINCT m.name, ', ') WITHIN GROUP (ORDER BY m.name) names
        FROM MLOPS_CONTROL.CORE.INCIDENT_SIGNALS x
        JOIN MLOPS_CONTROL.CORE.METRIC_CATALOG m ON m.metric_id = x.metric_id
        GROUP BY 1) a
  WHERE a.incident_id = i.incident_id AND i.status = 'open';

  -- 4. resolve incidents whose metrics have been evaluated normal for QUIET_MINUTES
  UPDATE MLOPS_CONTROL.CORE.INCIDENTS i SET status = 'resolved',
         resolved_at = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
  WHERE i.status = 'open'
    AND i.last_signal_at < DATEADD(minute, -:QUIET_MINUTES, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
    AND EXISTS (SELECT 1 FROM MLOPS_CONTROL.CORE.SIGNALS s
                WHERE s.system_id = i.system_id AND s.ts > i.last_signal_at AND NOT s.is_abnormal);
  resolved := SQLROWCOUNT;
  RETURN 'attached=' || attached || ' opened=' || opened || ' resolved=' || resolved;
END;
$$;

-- Slice an outcome by every configured dimension: where is the excess concentrated?
CREATE OR REPLACE PROCEDURE SLICE_EXCESS(ENTITY STRING, START_TS TIMESTAMP_NTZ, END_TS TIMESTAMP_NTZ)
RETURNS TABLE (dimension STRING, dim_value STRING, n NUMBER, rate FLOAT, baseline_rate FLOAT,
               excess FLOAT, share_of_excess FLOAT)
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
EXECUTE AS OWNER
AS
$$
import json, re
SAFE = re.compile(r"^[A-Za-z0-9_]+$")

def run(session, entity, start_ts, end_ts):
    cfg = session.sql("SELECT log_sql, dimensions FROM MLOPS_CONTROL.CORE.SLICE_CONFIG WHERE entity_id = ?",
                      params=[entity]).collect()
    if not cfg:
        raise ValueError(f"no slice config for {entity}")
    dims = [d for d in json.loads(cfg[0]["DIMENSIONS"]) if SAFE.match(d)]
    s, e = str(start_ts), str(end_ts)
    log = cfg[0]["LOG_SQL"].replace(":START", f"DATEADD(day,-7,'{s}'::TIMESTAMP_NTZ)").replace(":END", f"'{e}'::TIMESTAMP_NTZ")
    hrs = f"(SELECT DISTINCT HOUR(ts) FROM ({log}) WHERE ts >= '{s}'::TIMESTAMP_NTZ)"
    base = (f"WITH l AS (SELECT *, (ts >= '{s}'::TIMESTAMP_NTZ) AS in_w FROM ({log}) "
            f"WHERE ts >= '{s}'::TIMESTAMP_NTZ OR HOUR(ts) IN {hrs}), "
            f"tot AS (SELECT SUM(IFF(in_w, outcome, 0)) - COUNT_IF(in_w) * AVG(IFF(NOT in_w, outcome, NULL)) AS ex FROM l) ")
    unions = " UNION ALL ".join(
        f"SELECT '{d}' AS dimension, {d}::STRING AS dim_value, in_w, outcome FROM l" for d in dims)
    q = (base + f", u AS ({unions}), g AS ("
         "SELECT dimension, dim_value, COUNT_IF(in_w) n, AVG(IFF(in_w, outcome, NULL)) rate, "
         "AVG(IFF(NOT in_w, outcome, NULL)) baseline_rate FROM u GROUP BY 1,2 HAVING COUNT_IF(in_w) > 0) "
         "SELECT dimension::STRING, dim_value::STRING, n::NUMBER, rate::FLOAT, baseline_rate::FLOAT, "
         "(n * (rate - COALESCE(baseline_rate, 0)))::FLOAT AS excess, "
         "(n * (rate - COALESCE(baseline_rate, 0)) / NULLIF((SELECT ex FROM tot), 0))::FLOAT AS share_of_excess "
         "FROM g ORDER BY excess DESC")
    return session.sql(q)
$$;

---------------------------------------------------------------------------- read views
CREATE OR REPLACE VIEW V_ENTITY_HEALTH AS
-- health = each metric's LATEST reading (not "anything abnormal recently")
WITH latest AS (
  SELECT entity_id, metric_id, value, expected, expected_low, expected_high, is_abnormal, severity, ts
  FROM SIGNALS
  WHERE ts >= DATEADD(hour, -3, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY metric_id ORDER BY ts DESC) = 1
), recent AS (
  SELECT entity_id, COUNT_IF(is_abnormal) AS abnormal_now, MAX(IFF(is_abnormal, severity, 0)) AS max_sev
  FROM latest WHERE ts >= DATEADD(minute, -30, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) GROUP BY 1
)
SELECT e.system_id, e.entity_id, e.entity_type, e.name, e.fqn, e.stage, e.owner,
       COALESCE(r.abnormal_now, 0) AS abnormal_now, COALESCE(r.max_sev, 0) AS max_severity,
       CASE WHEN COALESCE(r.max_sev, 0) >= 3 THEN 'critical'
            WHEN COALESCE(r.abnormal_now, 0) > 0 THEN 'warning'
            WHEN (SELECT COUNT(*) FROM METRIC_CATALOG m WHERE m.entity_id = e.entity_id AND m.enabled) = 0 THEN 'unmonitored'
            ELSE 'healthy' END AS status,
       (SELECT ARRAY_AGG(OBJECT_CONSTRUCT('metric_id', l.metric_id, 'value', l.value, 'expected', l.expected,
                'low', l.expected_low, 'high', l.expected_high, 'abnormal', l.is_abnormal, 'ts', l.ts))
        FROM latest l WHERE l.entity_id = e.entity_id) AS latest_metrics
FROM ENTITIES e LEFT JOIN recent r ON r.entity_id = e.entity_id;

CREATE OR REPLACE VIEW V_COVERAGE AS
SELECT e.system_id, e.entity_id, e.name, e.entity_type, e.stage,
       (SELECT COUNT(*) FROM METRIC_CATALOG m WHERE m.entity_id = e.entity_id AND m.enabled) AS metrics,
       (SELECT COUNT(*) FROM EDGES g WHERE g.to_id = e.entity_id OR g.from_id = e.entity_id) AS lineage_edges,
       (SELECT COUNT(*) FROM COMPONENT_DEPLOY d WHERE d.entity_id = e.entity_id) AS deploy_hooks,
       ARRAY_CONSTRUCT_COMPACT(
         IFF(metrics = 0, 'no monitors', NULL),
         IFF(lineage_edges = 0, 'no lineage', NULL),
         IFF(e.stage = 'feature' AND deploy_hooks = 0, 'no deploy hook', NULL),
         IFF(e.stage = 'feature' AND NOT COALESCE(e.config:replayable::BOOLEAN, FALSE), 'not replayable (no counterfactual)', NULL)
       ) AS gaps
FROM ENTITIES e;

CREATE OR REPLACE VIEW V_AGENT_RUNS AS
SELECT agent_id, run_id, MIN(ts) AS started_at, MAX(ts) AS last_event_at,
       MAX(IFF(kind = 'run_end', ts, NULL)) AS ended_at,
       MAX(IFF(kind = 'run_end', attributes:verdict::STRING, NULL)) AS verdict,
       MAX(IFF(kind = 'run_end', attributes:status_line::STRING, NULL)) AS status_line,
       MAX(IFF(kind = 'run_start', attributes:trigger::STRING, NULL)) AS trigger_type,
       MAX(incident_id) AS incident_id,
       COUNT_IF(kind = 'tool') AS tool_calls, COUNT_IF(kind = 'hypothesis') AS hypothesis_events,
       COUNT_IF(kind = 'experiment') AS experiments, COUNT_IF(kind = 'proposal') AS proposals
FROM AGENT_EVENTS GROUP BY 1, 2;

-- latest state of each hypothesis per run
CREATE OR REPLACE VIEW V_HYPOTHESES AS
SELECT agent_id, run_id, incident_id, attributes:id::STRING AS hypothesis_id,
       attributes:text::STRING AS text, attributes:component::STRING AS component, status, ts,
       attributes AS detail
FROM AGENT_EVENTS WHERE kind = 'hypothesis'
QUALIFY ROW_NUMBER() OVER (PARTITION BY run_id, attributes:id::STRING ORDER BY seq DESC) = 1;

CREATE OR REPLACE VIEW V_EXPERIMENTS AS
SELECT agent_id, run_id, incident_id, ts, attributes:hypothesis_id::STRING AS hypothesis_id,
       attributes:intervention::STRING AS intervention, attributes:metric::STRING AS metric,
       attributes:actual::FLOAT AS actual, attributes:counterfactual::FLOAT AS counterfactual,
       attributes:baseline::FLOAT AS baseline, attributes:explained_pct::FLOAT AS explained_pct,
       attributes:rule::STRING AS rule, attributes:pass::BOOLEAN AS pass, attributes AS detail
FROM AGENT_EVENTS WHERE kind = 'experiment';

--------------------------------------------------------------------------- scheduling
CREATE OR REPLACE TASK TASK_CONTROL_PLANE
  WAREHOUSE = FRAUD_WH
  SCHEDULE = '5 MINUTE'
AS
EXECUTE IMMEDIATE $$
BEGIN
  CALL MLOPS_CONTROL.CORE.EVALUATE_METRICS(60);
  CALL MLOPS_CONTROL.CORE.SYNC_CHANGES(180);
  CALL MLOPS_CONTROL.CORE.CORRELATE_INCIDENTS(30, 15);
END;
$$;

------------------------------------------------------------------------ action policy
MERGE INTO ACTION_TYPES t USING (SELECT * FROM VALUES
  ('open_pr',              'Open a revert / fix pull request',             'agent',            FALSE, NULL,             'close PR'),
  ('merge_pr',             'Merge a pull request; CD deploys main',        'github_merge_pr',  TRUE,  'MLOPS_APPROVER', 'revert commit'),
  ('close_pr',             'Reject a proposed pull request',               'github_close_pr',  TRUE,  'MLOPS_APPROVER', 're-open PR'),
  ('rollback_model_default','Set model default version to a prior version', 'sql_procedure',   TRUE,  'MLOPS_APPROVER', 'set default back'),
  ('suspend_task',         'Suspend a pipeline task',                      'sql_procedure',    TRUE,  'MLOPS_APPROVER', 'resume task'),
  ('escalate',             'Escalate to on-call with findings',            'escalate',         FALSE, NULL,             'n/a')
  AS v(action_type, description, executor, requires_approval, approver_role, rollback)) s
ON t.action_type = s.action_type
WHEN NOT MATCHED THEN INSERT VALUES (s.action_type, s.description, s.executor, s.requires_approval, s.approver_role, s.rollback);

------------------------------------------------------------------------------ roles
CREATE ROLE IF NOT EXISTS MLOPS_UI_RO COMMENT = 'Mission Control read path';
CREATE ROLE IF NOT EXISTS MLOPS_APPROVER COMMENT = 'May approve agent-proposed actions';
GRANT ROLE MLOPS_UI_RO TO ROLE SYSADMIN;
GRANT ROLE MLOPS_APPROVER TO ROLE SYSADMIN;
GRANT USAGE ON DATABASE MLOPS_CONTROL TO ROLE MLOPS_UI_RO;
GRANT USAGE ON SCHEMA MLOPS_CONTROL.CORE TO ROLE MLOPS_UI_RO;
GRANT SELECT ON ALL TABLES IN SCHEMA MLOPS_CONTROL.CORE TO ROLE MLOPS_UI_RO;
GRANT SELECT ON ALL VIEWS IN SCHEMA MLOPS_CONTROL.CORE TO ROLE MLOPS_UI_RO;
GRANT SELECT ON FUTURE TABLES IN SCHEMA MLOPS_CONTROL.CORE TO ROLE MLOPS_UI_RO;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA MLOPS_CONTROL.CORE TO ROLE MLOPS_UI_RO;
GRANT USAGE ON PROCEDURE SLICE_EXCESS(STRING, TIMESTAMP_NTZ, TIMESTAMP_NTZ) TO ROLE MLOPS_UI_RO;
GRANT USAGE ON WAREHOUSE FRAUD_WH TO ROLE MLOPS_UI_RO;
