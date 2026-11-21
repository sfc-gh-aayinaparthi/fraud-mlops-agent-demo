-- 06 Agent investigation tools (all read-only for the caller)
USE ROLE ACCOUNTADMIN;
USE DATABASE FRAUD_AUTOML_DEMO;
USE WAREHOUSE FRAUD_WH;

-- Feature catalog: what each model input is built from (lineage the agent walks upstream)
CREATE OR REPLACE TABLE MONITORING.FEATURE_LINEAGE (
  feature STRING, is_model_input BOOLEAN, derived_from STRING, source_tables STRING,
  transformation STRING, owner STRING);
INSERT INTO MONITORING.FEATURE_LINEAGE VALUES
 ('amt_to_cust_avg_30d', TRUE,  'amount, cust_avg_amt_30d', 'RAW.TRANSACTIONS (+ any customer-profile source used for cust_avg_amt_30d)', 'amount / COALESCE(cust_avg_amt_30d, 1)', 'fraud-data-eng'),
 ('cust_avg_amt_30d',    FALSE, 'amount history', 'RAW.TRANSACTIONS (v1 window) / RAW.CUSTOMER_PROFILE_V2 (if used)', '30-day average spend per customer', 'fraud-data-eng'),
 ('amount',              TRUE,  'amount', 'RAW.TRANSACTIONS', 'passthrough', 'payments-platform'),
 ('txn_count_1h',        TRUE,  'card_id, txn_ts', 'RAW.TRANSACTIONS', 'card velocity, 1h window', 'fraud-data-eng'),
 ('txn_count_24h',       TRUE,  'card_id, txn_ts', 'RAW.TRANSACTIONS', 'card velocity, 24h window', 'fraud-data-eng'),
 ('distance_from_home_km',TRUE, 'home lat/lon, merchant lat/lon', 'RAW.CUSTOMERS, RAW.MERCHANTS', 'haversine distance', 'fraud-data-eng'),
 ('merchant_risk_score', TRUE,  'merchant_risk_score', 'RAW.MERCHANTS', 'passthrough', 'merchant-risk'),
 ('is_new_merchant',     TRUE,  'customer_id, merchant_id', 'RAW.TRANSACTIONS', 'first txn at merchant in 30d', 'fraud-data-eng'),
 ('hour_of_day',         TRUE,  'txn_ts', 'RAW.TRANSACTIONS', 'HOUR(txn_ts)', 'fraud-data-eng'),
 ('is_online',           TRUE,  'channel', 'RAW.TRANSACTIONS', 'channel = ONLINE', 'payments-platform');

-- 1. Where is the excess concentrated? Compares [START_TS, END_TS) with the same
--    hours-of-day over the prior 7 days, per dimension value.
CREATE OR REPLACE FUNCTION MONITORING.FN_SPIKE_BREAKDOWN(START_TS TIMESTAMP_NTZ, END_TS TIMESTAMP_NTZ)
RETURNS TABLE (dimension STRING, dim_value STRING, n NUMBER, flag_rate FLOAT, baseline_rate FLOAT,
               excess_flags NUMBER, share_of_total_excess FLOAT)
AS
$$
WITH p AS (
  SELECT p.txn_ts, p.is_flagged, p.model_version, p.feature_pipeline_version,
         f.issuing_platform, f.merchant_category, f.home_state,
         IFF(f.card_issued_dt >= '2026-11-01', 'ISSUED_SINCE_NOV', 'ISSUED_BEFORE_NOV') AS card_cohort,
         IFF(f.is_online = 1, 'ONLINE', 'NOT_ONLINE') AS channel,
         (p.txn_ts >= START_TS AND p.txn_ts < END_TS) AS in_window
  FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS p
  JOIN FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG f ON f.txn_id = p.txn_id
  WHERE (p.txn_ts >= START_TS AND p.txn_ts < END_TS)
     OR (p.txn_ts >= DATEADD(day, -7, START_TS) AND p.txn_ts < START_TS
         AND HOUR(p.txn_ts) IN (SELECT DISTINCT HOUR(DATEADD(minute, 15 * SEQ4(), START_TS))
                                FROM TABLE(GENERATOR(ROWCOUNT => 96))
                                WHERE DATEADD(minute, 15 * SEQ4(), START_TS) < END_TS))
), u AS (
  SELECT 'card_cohort' AS dimension, card_cohort AS dim_value, in_window, is_flagged FROM p UNION ALL
  SELECT 'issuing_platform', issuing_platform, in_window, is_flagged FROM p UNION ALL
  SELECT 'merchant_category', merchant_category, in_window, is_flagged FROM p UNION ALL
  SELECT 'home_state', home_state, in_window, is_flagged FROM p UNION ALL
  SELECT 'channel', channel, in_window, is_flagged FROM p UNION ALL
  SELECT 'model_version', model_version, in_window, is_flagged FROM p UNION ALL
  SELECT 'feature_pipeline_version', feature_pipeline_version, in_window, is_flagged FROM p
), a AS (
  SELECT dimension, dim_value,
         COUNT_IF(in_window) AS n,
         AVG(IFF(in_window, is_flagged, NULL)) AS flag_rate,
         AVG(IFF(NOT in_window, is_flagged, NULL)) AS baseline_rate
  FROM u GROUP BY 1, 2
), t AS (
  SELECT SUM(is_flagged) - COUNT(*) * (SELECT AVG(IFF(NOT in_window, is_flagged, NULL)) FROM p) AS total_excess
  FROM p WHERE in_window
)
SELECT a.dimension, a.dim_value, a.n, ROUND(a.flag_rate, 4)::FLOAT, ROUND(a.baseline_rate, 4)::FLOAT,
       ROUND(a.n * (a.flag_rate - COALESCE(a.baseline_rate, 0)))::NUMBER AS excess_flags,
       ROUND(a.n * (a.flag_rate - COALESCE(a.baseline_rate, 0)) / NULLIF(t.total_excess, 0), 3)::FLOAT
FROM a, t
WHERE a.n > 0
$$;

-- 2. Feature health per 5-min bucket (served features): null % and mean per model input
CREATE OR REPLACE VIEW MONITORING.V_FEATURE_HEALTH AS
SELECT TIME_SLICE(txn_ts, 5, 'MINUTE') AS bucket_start, COUNT(*) AS n,
       ROUND(100 * COUNT_IF(cust_avg_amt_30d IS NULL) / COUNT(*), 2)      AS pct_null_cust_avg_amt_30d,
       ROUND(100 * COUNT_IF(distance_from_home_km IS NULL) / COUNT(*), 2) AS pct_null_distance_from_home_km,
       ROUND(100 * COUNT_IF(merchant_risk_score IS NULL) / COUNT(*), 2)   AS pct_null_merchant_risk_score,
       ROUND(MEDIAN(amt_to_cust_avg_30d), 3) AS median_amt_to_cust_avg_30d,
       ROUND(AVG(amt_to_cust_avg_30d), 3)    AS mean_amt_to_cust_avg_30d,
       ROUND(AVG(amount), 2)                 AS mean_amount,
       ROUND(AVG(txn_count_24h), 3)          AS mean_txn_count_24h,
       ROUND(AVG(distance_from_home_km), 1)  AS mean_distance_from_home_km,
       ROUND(AVG(merchant_risk_score), 3)    AS mean_merchant_risk_score,
       LISTAGG(DISTINCT feature_pipeline_version, ',') AS pipeline_versions
FROM SERVING.FEATURE_LOG
WHERE txn_ts >= DATEADD(day, -2, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
GROUP BY 1;

-- 3. DMF results on the feature log, with the null rate of rows that arrived between
--    consecutive measurements (cumulative counts -> incremental rate)
CREATE OR REPLACE VIEW MONITORING.V_DMF_RESULTS AS
SELECT measurement_time, metric_name,
       ARRAY_TO_STRING(argument_names, ',') AS column_name,
       value
FROM TABLE(SNOWFLAKE.LOCAL.DATA_QUALITY_MONITORING_RESULTS(
       REF_ENTITY_NAME => 'FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG', REF_ENTITY_DOMAIN => 'TABLE'))
WHERE measurement_time >= DATEADD(day, -2, CURRENT_TIMESTAMP());

-- 4. Every change near a time window: deploys of any component, failed tasks
CREATE OR REPLACE VIEW MONITORING.V_RECENT_CHANGES AS
SELECT deployed_at AS changed_at, component, object_name,
       COALESCE(previous_version, '-') || ' -> ' || version AS change,
       commit_sha, author, message, 'deploy' AS change_type
FROM MONITORING.PIPELINE_CHANGE_LOG
WHERE deployed_at >= DATEADD(day, -14, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
UNION ALL
SELECT completed_time::TIMESTAMP_NTZ, 'task', database_name || '.' || schema_name || '.' || name,
       state, NULL, NULL, LEFT(error_message, 300), 'task_failure'
FROM TABLE(INFORMATION_SCHEMA.TASK_HISTORY(
       SCHEDULED_TIME_RANGE_START => DATEADD(day, -2, CURRENT_TIMESTAMP()), ERROR_ONLY => TRUE));

-- Investigation log (written by the human-approved process / CI, read by the agent for de-dup)
CREATE TABLE IF NOT EXISTS MONITORING.AGENT_INCIDENTS (
  incident_id STRING DEFAULT UUID_STRING(), opened_at TIMESTAMP_NTZ, status STRING,
  cause STRING, confirmed BOOLEAN, summary STRING, report STRING, pr_url STRING,
  resolved_at TIMESTAMP_NTZ);

-- 5. Counterfactual: re-score a window with ONE component reverted, everything else fixed.
--    revert_type:
--      pipeline_version  -> rebuild features with a logged pipeline version's SQL
--      model_version     -> score the served features with another model version
--      input_asof        -> active pipeline, but dimension inputs as of a timestamp (Time Travel)
--      feature_ablation  -> replace one model input with its prior-7-day median (sensitivity only)
--    Read-only: every statement is a SELECT.
CREATE OR REPLACE PROCEDURE MONITORING.COUNTERFACTUAL_RATE(
  REVERT_TYPE STRING, REVERT_VALUE STRING, START_TS TIMESTAMP_NTZ, END_TS TIMESTAMP_NTZ)
RETURNS TABLE (revert_type STRING, revert_value STRING, active_pipeline STRING, active_model STRING,
               window_start TIMESTAMP_NTZ, window_end TIMESTAMP_NTZ, n NUMBER,
               actual_rate FLOAT, counterfactual_rate FLOAT, baseline_rate FLOAT,
               excess_explained_pct FLOAT, passes_confirmation BOOLEAN, by_cohort VARIANT, note STRING)
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
EXECUTE AS OWNER
AS
$$
import json
import re

DB = "FRAUD_AUTOML_DEMO"
DIM_TABLES = ["CUSTOMERS", "MERCHANTS", "CARDS", "CUSTOMER_PROFILE_V2"]
ARGS = {
    "V0": ["amount", "amt_to_cust_avg_30d", "merchant_risk_score", "hour_of_day", "is_online"],
    "V1": ["amount", "amt_to_cust_avg_30d", "txn_count_1h", "txn_count_24h", "distance_from_home_km",
           "merchant_risk_score", "is_new_merchant", "hour_of_day", "is_online"],
}
SAFE = re.compile(r"^[A-Za-z0-9_]+$")
TS = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$")


def one(session, sql, params=None):
    return session.sql(sql, params=params).collect()[0][0]


def pipeline_body(session, version):
    src = one(session,
        f"SELECT source_sql FROM {DB}.MONITORING.PIPELINE_CHANGE_LOG WHERE component = 'feature_pipeline' "
        "AND version = ? AND source_sql IS NOT NULL ORDER BY deployed_at DESC LIMIT 1", [version.upper()])
    if src is None:
        raise ValueError(f"no logged source SQL for pipeline version {version}")
    delim = "$" + "$"  # the function body delimiter, split so this proc body stays valid
    return src[src.index(delim) + 2: src.rindex(delim)]


def bind_window(body, s, e):
    body = re.sub(r"\bSTART_TS\b", f"'{s}'::TIMESTAMP_NTZ", body)
    return re.sub(r"\bEND_TS\b", f"'{e}'::TIMESTAMP_NTZ", body)


def score(session, features_sql, model_version):
    args = ", ".join(ARGS[model_version])
    q = (f"WITH m AS MODEL {DB}.ML.FRAUD_XGB VERSION {model_version} "
         f"SELECT IFF(f.card_issued_dt >= '2026-11-01', 'ISSUED_SINCE_NOV', 'ISSUED_BEFORE_NOV') AS cohort, "
         f"IFF(m!PREDICT_PROBA({args}):output_feature_1::FLOAT >= 0.5, 1, 0) AS flag "
         f"FROM ({features_sql}) f")
    rows = session.sql(f"SELECT cohort, COUNT(*) n, AVG(flag) r FROM ({q}) GROUP BY cohort").collect()
    n = sum(r["N"] for r in rows)
    rate = sum(r["N"] * float(r["R"]) for r in rows) / n if n else None
    return n, rate, {r["COHORT"]: {"n": r["N"], "rate": round(float(r["R"]), 4)} for r in rows}


def run(session, revert_type, revert_value, start_ts, end_ts):
    s, e = str(start_ts), str(end_ts)
    if not (TS.match(s) and TS.match(e)):
        raise ValueError("bad timestamps")
    revert_type = (revert_type or "").lower()
    active_fp = one(session, f"SELECT MAX(version) FROM {DB}.OPS.ACTIVE_COMPONENTS WHERE component='feature_pipeline'")
    active_mv = one(session, f"SELECT MAX(version) FROM {DB}.OPS.ACTIVE_COMPONENTS WHERE component='model'")
    served = (f"SELECT * FROM {DB}.SERVING.FEATURE_LOG WHERE txn_ts >= '{s}'::TIMESTAMP_NTZ "
              f"AND txn_ts < '{e}'::TIMESTAMP_NTZ")
    note = ""

    if revert_type == "pipeline_version":
        if not SAFE.match(revert_value or ""):
            raise ValueError("bad version")
        n, cf, coh = score(session, bind_window(pipeline_body(session, revert_value), s, e), active_mv)
        note = f"features rebuilt with pipeline {revert_value.upper()} (logged SQL), scored by model {active_mv}"
    elif revert_type == "model_version":
        mv = (revert_value or "").upper()
        if mv not in ARGS:
            raise ValueError(f"unknown model version {revert_value}")
        n, cf, coh = score(session, served, mv)
        note = f"served features scored by model {mv} instead of {active_mv}"
    elif revert_type == "input_asof":
        if not TS.match(revert_value or ""):
            raise ValueError("input_asof needs a timestamp")
        body = bind_window(pipeline_body(session, active_fp), s, e)
        for t in DIM_TABLES:
            body = re.sub(rf"{DB}\.RAW\.{t}\b",
                          f"{DB}.RAW.{t} AT(TIMESTAMP => '{revert_value}'::TIMESTAMP_LTZ)", body)
        n, cf, coh = score(session, body, active_mv)
        note = (f"active pipeline {active_fp}, dimension tables {','.join(DIM_TABLES)} as of {revert_value} "
                "(Time Travel); transactions unchanged")
    elif revert_type == "feature_ablation":
        feat = (revert_value or "").lower()
        if feat not in ARGS["V1"]:
            raise ValueError(f"{revert_value} is not a model input")
        med = one(session,
            f"SELECT MEDIAN({feat}) FROM {DB}.SERVING.FEATURE_LOG "
            f"WHERE txn_ts >= DATEADD(day, -7, '{s}'::TIMESTAMP_NTZ) AND txn_ts < '{s}'::TIMESTAMP_NTZ")
        n, cf, coh = score(session, f"SELECT * REPLACE ({med}::FLOAT AS {feat}) FROM ({served})", active_mv)
        note = (f"{feat} replaced by prior-7-day median {med}; sensitivity check only - also removes "
                "genuine signal, so never sufficient to confirm a cause")
    else:
        raise ValueError("revert_type must be pipeline_version | model_version | input_asof | feature_ablation")

    actual = one(session,
        f"SELECT AVG(is_flagged) FROM {DB}.SERVING.PREDICTIONS WHERE txn_ts >= '{s}'::TIMESTAMP_NTZ "
        f"AND txn_ts < '{e}'::TIMESTAMP_NTZ")
    baseline = one(session,
        f"SELECT AVG(is_flagged) FROM {DB}.SERVING.PREDICTIONS "
        f"WHERE txn_ts >= DATEADD(day, -7, '{s}'::TIMESTAMP_NTZ) AND txn_ts < '{s}'::TIMESTAMP_NTZ "
        f"AND HOUR(txn_ts) IN (SELECT DISTINCT HOUR(txn_ts) FROM {DB}.SERVING.PREDICTIONS "
        f"WHERE txn_ts >= '{s}'::TIMESTAMP_NTZ AND txn_ts < '{e}'::TIMESTAMP_NTZ)")
    actual, baseline = float(actual or 0), float(baseline or 0)
    explained = None
    if cf is not None and actual - baseline > 0:
        explained = round(100 * (actual - cf) / (actual - baseline), 1)
    passes = (revert_type != "feature_ablation" and cf is not None
              and abs(cf - baseline) <= 0.01 and actual > 2 * baseline
              and explained is not None and explained >= 80)
    return session.create_dataframe(
        [[revert_type, revert_value, active_fp, active_mv, s, e, n, round(actual, 4),
          None if cf is None else round(cf, 4), round(baseline, 4), explained, passes,
          json.dumps(coh), note]],
        schema=["revert_type", "revert_value", "active_pipeline", "active_model", "window_start",
                "window_end", "n", "actual_rate", "counterfactual_rate", "baseline_rate",
                "excess_explained_pct", "passes_confirmation", "by_cohort", "note"],
    ).select_expr("revert_type", "revert_value", "active_pipeline", "active_model",
                  "window_start::TIMESTAMP_NTZ", "window_end::TIMESTAMP_NTZ", "n", "actual_rate",
                  "counterfactual_rate", "baseline_rate", "excess_explained_pct", "passes_confirmation",
                  "PARSE_JSON(by_cohort)", "note")
$$;

GRANT USAGE ON PROCEDURE MONITORING.COUNTERFACTUAL_RATE(STRING, STRING, TIMESTAMP_NTZ, TIMESTAMP_NTZ) TO ROLE FRAUD_AGENT_RO;
GRANT USAGE ON FUNCTION MONITORING.FN_SPIKE_BREAKDOWN(TIMESTAMP_NTZ, TIMESTAMP_NTZ) TO ROLE FRAUD_AGENT_RO;
GRANT SELECT ON ALL TABLES IN DATABASE FRAUD_AUTOML_DEMO TO ROLE FRAUD_AGENT_RO;
GRANT SELECT ON ALL VIEWS IN DATABASE FRAUD_AUTOML_DEMO TO ROLE FRAUD_AGENT_RO;
