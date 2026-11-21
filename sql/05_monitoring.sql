-- 05 Monitoring: monitor source, baseline, model monitor, DMFs, fraud-rate anomaly view
USE ROLE ACCOUNTADMIN;
USE DATABASE FRAUD_AUTOML_DEMO;
USE WAREHOUSE FRAUD_WH;

-- Model monitor source: features as served + score + (late-arriving) label
CREATE OR REPLACE VIEW SERVING.V_MONITOR_SOURCE AS
SELECT p.txn_ts, p.txn_id,
       f.amount, f.amt_to_cust_avg_30d, f.txn_count_1h::FLOAT AS txn_count_1h, f.txn_count_24h::FLOAT AS txn_count_24h,
       f.distance_from_home_km, f.merchant_risk_score, f.is_new_merchant::FLOAT AS is_new_merchant,
       f.hour_of_day::FLOAT AS hour_of_day, f.is_online::FLOAT AS is_online,
       p.fraud_score, p.is_flagged::FLOAT AS is_flagged,
       l.is_fraud::INT::FLOAT AS actual_fraud,
       f.issuing_platform,
       IFF(f.card_issued_dt >= '2026-11-01', 'ISSUED_SINCE_NOV', 'ISSUED_BEFORE_NOV') AS card_cohort,
       f.merchant_category
FROM SERVING.PREDICTIONS p
JOIN SERVING.FEATURE_LOG f ON f.txn_id = p.txn_id
LEFT JOIN RAW.FRAUD_LABELS l ON l.txn_id = p.txn_id
WHERE p.model_version = 'V1';

-- Baseline: hold-out window of the training set, scored by V1
CREATE OR REPLACE TABLE ML.FRAUD_XGB_V1_BASELINE AS
WITH m AS MODEL ML.FRAUD_XGB VERSION V1
SELECT t.txn_ts, t.txn_id, t.amount, t.amt_to_cust_avg_30d, t.txn_count_1h::FLOAT AS txn_count_1h,
       t.txn_count_24h::FLOAT AS txn_count_24h, t.distance_from_home_km, t.merchant_risk_score,
       t.is_new_merchant::FLOAT AS is_new_merchant, t.hour_of_day::FLOAT AS hour_of_day, t.is_online::FLOAT AS is_online,
       m!PREDICT_PROBA(t.amount, t.amt_to_cust_avg_30d, t.txn_count_1h, t.txn_count_24h, t.distance_from_home_km,
                       t.merchant_risk_score, t.is_new_merchant, t.hour_of_day, t.is_online):output_feature_1::FLOAT AS fraud_score,
       IFF(fraud_score >= 0.5, 1, 0)::FLOAT AS is_flagged,
       t.is_fraud::FLOAT AS actual_fraud,
       t.issuing_platform,
       IFF(t.card_issued_dt >= '2026-11-01', 'ISSUED_SINCE_NOV', 'ISSUED_BEFORE_NOV') AS card_cohort,
       t.merchant_category
FROM ML.TRAINING_SET_V1 t
WHERE t.txn_ts >= '2026-11-05';

CREATE OR REPLACE MODEL MONITOR ML.FRAUD_XGB_V1_MONITOR WITH
  MODEL = ML.FRAUD_XGB
  VERSION = 'V1'
  FUNCTION = 'PREDICT_PROBA'
  SOURCE = SERVING.V_MONITOR_SOURCE
  BASELINE = ML.FRAUD_XGB_V1_BASELINE
  WAREHOUSE = FRAUD_WH
  REFRESH_INTERVAL = '5 minutes'
  AGGREGATION_WINDOW = '1 day'
  TIMESTAMP_COLUMN = TXN_TS
  ID_COLUMNS = ('TXN_ID')
  PREDICTION_SCORE_COLUMNS = ('FRAUD_SCORE')
  ACTUAL_CLASS_COLUMNS = ('ACTUAL_FRAUD')
  SEGMENT_COLUMNS = ('CARD_COHORT', 'ISSUING_PLATFORM', 'MERCHANT_CATEGORY');

-- Data metric functions on the served feature log
ALTER TABLE SERVING.FEATURE_LOG SET DATA_METRIC_SCHEDULE = '5 MINUTE';
ALTER TABLE SERVING.FEATURE_LOG ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.NULL_COUNT ON (cust_avg_amt_30d);
ALTER TABLE SERVING.FEATURE_LOG ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.NULL_COUNT ON (distance_from_home_km);
ALTER TABLE SERVING.FEATURE_LOG ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.NULL_COUNT ON (merchant_risk_score);
ALTER TABLE SERVING.FEATURE_LOG ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.ROW_COUNT ON ();

-- (DMF bodies cannot use CURRENT_TIMESTAMP, so "null rate of newly arrived rows" is derived
--  from consecutive NULL_COUNT / ROW_COUNT measurements in MONITORING.V_DMF_ANOMALIES)

-- Fraud-flag rate per 5-minute bucket vs same-hour-of-day baseline (prior 7 days)
CREATE OR REPLACE VIEW MONITORING.V_FRAUD_RATE_ANOMALY AS
WITH b AS (
  SELECT TIME_SLICE(txn_ts, 5, 'MINUTE') AS bucket_start, COUNT(*) AS n, AVG(is_flagged) AS flag_rate
  FROM SERVING.PREDICTIONS
  WHERE txn_ts >= DATEADD(day, -8, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
  GROUP BY 1
), base AS (
  SELECT HOUR(bucket_start) AS hr, AVG(flag_rate) AS base_rate, STDDEV(flag_rate) AS base_sd
  FROM b
  WHERE bucket_start < DATEADD(hour, -6, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
  GROUP BY 1
)
SELECT b.bucket_start, b.n, ROUND(b.flag_rate, 4) AS flag_rate,
       ROUND(base.base_rate, 4) AS baseline_rate,
       ROUND((b.flag_rate - base.base_rate) / NULLIF(base.base_sd, 0), 2) AS z_score,
       ROUND(b.n * (b.flag_rate - base.base_rate)) AS excess_flags,
       (b.flag_rate > 2 * base.base_rate AND (b.flag_rate - base.base_rate) / NULLIF(base.base_sd, 0) > 4 AND b.n >= 50) AS is_anomaly
FROM b JOIN base ON base.hr = HOUR(b.bucket_start)
WHERE b.bucket_start >= DATEADD(hour, -24, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);
