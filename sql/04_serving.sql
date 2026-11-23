-- 04 Serving: v2 profile table (used by the planted change), feature log, predictions,
--    version-stamped scoring, and the live pipeline tick task.
USE ROLE ACCOUNTADMIN;
USE DATABASE FRAUD_AUTOML_DEMO;
USE WAREHOUSE FRAUD_WH;

-- New customer-profile platform: precomputed card-level spend profile.
-- Backfilled from a 1-Nov snapshot, so cards issued after 1-Nov have no row (the latent gap).
CREATE OR REPLACE TABLE RAW.CUSTOMER_PROFILE_V2 AS
SELECT cd.card_id, cd.customer_id,
       AVG(t.amount) AS avg_amt_30d,
       COUNT(*) AS txn_count_30d,
       '2026-11-01'::DATE AS snapshot_dt
FROM RAW.CARDS cd
JOIN RAW.TRANSACTIONS t
  ON t.customer_id = cd.customer_id
 AND t.txn_ts >= '2026-10-02' AND t.txn_ts < '2026-11-01'
WHERE cd.issued_dt < '2026-11-01'
GROUP BY cd.card_id, cd.customer_id;

-- Features exactly as they were fed to the model (the production feature log)
CREATE TABLE IF NOT EXISTS SERVING.FEATURE_LOG (
  txn_id STRING, card_id NUMBER, customer_id NUMBER, merchant_id NUMBER, txn_ts TIMESTAMP_NTZ,
  amount FLOAT, cust_avg_amt_30d FLOAT, amt_to_cust_avg_30d FLOAT,
  txn_count_1h NUMBER, txn_count_24h NUMBER, distance_from_home_km FLOAT,
  merchant_risk_score FLOAT, is_new_merchant NUMBER, hour_of_day NUMBER, is_online NUMBER,
  merchant_category STRING, issuing_platform STRING, card_issued_dt DATE, home_state STRING,
  feature_pipeline_version STRING, scored_at TIMESTAMP_NTZ
);

-- Every prediction is stamped with the code + model that produced it
CREATE TABLE IF NOT EXISTS SERVING.PREDICTIONS (
  txn_id STRING, txn_ts TIMESTAMP_NTZ, card_id NUMBER,
  fraud_score FLOAT, is_flagged NUMBER,
  model_name STRING, model_version STRING, feature_pipeline_version STRING,
  scored_at TIMESTAMP_NTZ
);

INSERT INTO OPS.ACTIVE_COMPONENTS
SELECT 'model', 'V1', CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
WHERE NOT EXISTS (SELECT 1 FROM OPS.ACTIVE_COMPONENTS WHERE component = 'model');

INSERT INTO MONITORING.PIPELINE_CHANGE_LOG (component, object_name, version, previous_version, commit_sha, author, message, deployed_at)
SELECT 'model', 'ML.FRAUD_XGB', 'V1', 'V0', NULL, 'model-registry', 'Promote FRAUD_XGB V1 to default', '2026-11-14 09:00:00'
WHERE NOT EXISTS (SELECT 1 FROM MONITORING.PIPELINE_CHANGE_LOG WHERE component = 'model');

CREATE TABLE IF NOT EXISTS OPS.PIPELINE_STATE (last_tick TIMESTAMP_NTZ);

-- Score [START_TS, END_TS) with the active feature set (Feature Store) and model version
CREATE OR REPLACE PROCEDURE SERVING.SCORE_WINDOW(START_TS TIMESTAMP_NTZ, END_TS TIMESTAMP_NTZ)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  fv STRING;
  mv STRING;
  args STRING;
  q STRING;
  n NUMBER;
BEGIN
  SELECT MAX(set_version) INTO :fv FROM OPS.ACTIVE_FEATURE_SET;
  SELECT MAX(version) INTO :mv FROM OPS.ACTIVE_COMPONENTS WHERE component = 'model';
  -- model inputs come from the registered model version's signature
  EXECUTE IMMEDIATE 'SHOW FUNCTIONS IN MODEL ML.FRAUD_XGB VERSION ' || :mv;
  SELECT REGEXP_REPLACE(TRIM("arguments", '()'), '([A-Z0-9_]+) [A-Z_]+(\\([0-9, ]*\\))?', '\\1') INTO :args
    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE "name" = 'PREDICT_PROBA';

  CALL OPS.REFRESH_FEATURE_SET(:fv);
  CALL FEATURES.FEATURE_SET_SQL(:fv, :START_TS::STRING, :END_TS::STRING, NULL) INTO :q;
  EXECUTE IMMEDIATE
    'INSERT INTO SERVING.FEATURE_LOG SELECT f.*, ''' || :fv || ''', CURRENT_TIMESTAMP()::TIMESTAMP_NTZ ' ||
    'FROM (' || :q || ') f';
  n := SQLROWCOUNT;

  EXECUTE IMMEDIATE
    'INSERT INTO SERVING.PREDICTIONS ' ||
    'WITH m AS MODEL ML.FRAUD_XGB VERSION ' || :mv || ' ' ||
    'SELECT f.txn_id, f.txn_ts, f.card_id, m!PREDICT_PROBA(' || :args || '):output_feature_1::FLOAT AS s, ' ||
    'IFF(s >= 0.5, 1, 0), ''FRAUD_XGB'', ''' || :mv || ''', ''' || :fv || ''', f.scored_at ' ||
    'FROM SERVING.FEATURE_LOG f ' ||
    'WHERE f.txn_ts >= ''' || :START_TS || '''::TIMESTAMP_NTZ AND f.txn_ts < ''' || :END_TS || '''::TIMESTAMP_NTZ ' ||
    'AND f.txn_id NOT IN (SELECT txn_id FROM SERVING.PREDICTIONS WHERE txn_ts >= ''' || :START_TS || '''::TIMESTAMP_NTZ)';

  RETURN 'scored ' || :n || ' txns with features ' || :fv || ', model ' || :mv;
END;
$$;

-- One tick of the live pipeline: land new transactions, then score them
CREATE OR REPLACE PROCEDURE OPS.PIPELINE_TICK()
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  s TIMESTAMP_NTZ;
  e TIMESTAMP_NTZ;
  n NUMBER;
  burst_cat STRING;
  burst_rate FLOAT;
  r STRING;
BEGIN
  SELECT MAX(last_tick) INTO :s FROM OPS.PIPELINE_STATE;
  e := DATE_TRUNC(second, CURRENT_TIMESTAMP())::TIMESTAMP_NTZ;
  IF (:s IS NULL OR DATEDIFF(minute, :s, :e) > 60) THEN
    s := DATEADD(minute, -5, :e);
  END IF;
  n := GREATEST(10, ROUND(DATEDIFF(second, :s, :e) * 1650 / 3600));
  SELECT MAX(category), MAX(rate) INTO :burst_cat, :burst_rate FROM OPS.ACTIVE_FRAUD_BURST WHERE active;
  CALL OPS.GENERATE_TRANSACTIONS(:s, :e, :n, 0.02, :burst_cat, COALESCE(:burst_rate, 0), 3, FALSE);
  CALL SERVING.SCORE_WINDOW(:s, :e) INTO :r;
  -- labels that have now "arrived"
  INSERT INTO RAW.FRAUD_LABELS
  SELECT g.* FROM RAW.FRAUD_GROUND_TRUTH g
  WHERE g.labelled_at <= :e AND g.labelled_at > DATEADD(day, -1, :e)
    AND NOT EXISTS (SELECT 1 FROM RAW.FRAUD_LABELS l WHERE l.txn_id = g.txn_id);
  DELETE FROM OPS.PIPELINE_STATE;
  INSERT INTO OPS.PIPELINE_STATE VALUES (:e);
  RETURN :r;
END;
$$;

-- Toggle used only by the "genuine fraud burst" demo scenario
CREATE TABLE IF NOT EXISTS OPS.ACTIVE_FRAUD_BURST (category STRING, rate FLOAT, active BOOLEAN);

CREATE OR REPLACE TASK OPS.TASK_PIPELINE_TICK
  WAREHOUSE = FRAUD_WH
  SCHEDULE = '5 MINUTE'
  AS CALL OPS.PIPELINE_TICK();
