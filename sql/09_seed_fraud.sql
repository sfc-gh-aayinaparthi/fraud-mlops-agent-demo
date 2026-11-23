-- 09 Seed: the fraud scoring system, expressed purely as control-plane configuration.
USE ROLE ACCOUNTADMIN;
USE SCHEMA MLOPS_CONTROL.CORE;
USE WAREHOUSE FRAUD_WH;

DELETE FROM SYSTEMS WHERE system_id = 'fraud';
INSERT INTO SYSTEMS SELECT 'fraud', 'Card fraud scoring', 'Real-time card transaction fraud model (XGBoost)',
  'fraud-ml-eng', 'https://github.com/sfc-gh-aayinaparthi/fraud-mlops-agent-demo',
  'USER$ANUDEEP.PUBLIC.COCO_ROUTINE_FRAUD_WATCH', PARSE_JSON('{"timezone":"Australia/Sydney"}'), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

DELETE FROM ENTITIES WHERE system_id = 'fraud';
INSERT INTO ENTITIES SELECT column1, 'fraud', column2, column3, column4, column5, column6, PARSE_JSON(column7) FROM VALUES
 ('fraud.src.transactions', 'table', 'Transactions', 'FRAUD_AUTOML_DEMO.RAW.TRANSACTIONS', 'source', 'payments-platform', '{"subtitle":"Incoming card transactions"}'),
 ('fraud.src.customers', 'table', 'Customers', 'FRAUD_AUTOML_DEMO.RAW.CUSTOMERS', 'source', 'customer-data', '{"subtitle":"Customer home location"}'),
 ('fraud.src.cards', 'table', 'Cards', 'FRAUD_AUTOML_DEMO.RAW.CARDS', 'source', 'card-platform', '{"subtitle":"Card issue date and platform"}'),
 ('fraud.src.merchants', 'table', 'Merchants', 'FRAUD_AUTOML_DEMO.RAW.MERCHANTS', 'source', 'merchant-risk', '{"subtitle":"Merchant category and risk score"}'),
 ('fraud.src.customer_profile_v2', 'table', 'Customer profiles (new, v2)', 'FRAUD_AUTOML_DEMO.RAW.CUSTOMER_PROFILE_V2', 'source', 'customer-data', '{"subtitle":"Precomputed spend per card; used only by feature set v2"}'),
 ('fraud.src.labels', 'table', 'Confirmed fraud', 'FRAUD_AUTOML_DEMO.RAW.FRAUD_LABELS', 'source', 'fraud-ops', '{"subtitle":"Arrives later; used to measure accuracy"}'),
 ('fraud.fs.customer_spend', 'feature_view', 'Customer spend (30 days)', 'FRAUD_AUTOML_DEMO.FEATURE_STORE."CUSTOMER_SPEND$V1"', 'feature_store', 'fraud-data-eng', '{"subtitle":"Feature view: average spend per customer, as of each transaction (refreshed before every scoring run)"}'),
 ('fraud.fs.card_spend_profile', 'feature_view', 'Card spend profile (v2)', 'FRAUD_AUTOML_DEMO.FEATURE_STORE."CARD_SPEND_PROFILE$V1"', 'feature_store', 'customer-data', '{"subtitle":"Feature view: spend per card from the new profile platform; used only by feature set v2"}'),
 ('fraud.fs.customer_profile', 'feature_view', 'Customer profile', 'FRAUD_AUTOML_DEMO.FEATURE_STORE."CUSTOMER_PROFILE$V1"', 'feature_store', 'customer-data', '{"subtitle":"Feature view: home location and state"}'),
 ('fraud.fs.merchant_profile', 'feature_view', 'Merchant profile', 'FRAUD_AUTOML_DEMO.FEATURE_STORE."MERCHANT_PROFILE$V1"', 'feature_store', 'merchant-risk', '{"subtitle":"Feature view: risk score, location and category"}'),
 ('fraud.fs.card_profile', 'feature_view', 'Card profile', 'FRAUD_AUTOML_DEMO.FEATURE_STORE."CARD_PROFILE$V1"', 'feature_store', 'card-platform', '{"subtitle":"Feature view: issuing platform and issue date"}'),
 ('fraud.feat.txn_features', 'feature_set', 'Feature set', 'FRAUD_AUTOML_DEMO.OPS.FEATURE_SETS', 'feature', 'fraud-data-eng', '{"replayable": true, "subtitle":"Versioned set of feature views, joined as of each transaction plus per-transaction inputs: the model''s 9 inputs (a copy of each is kept for audit)"}'),
 ('fraud.model.fraud_xgb', 'model', 'Fraud model', 'FRAUD_AUTOML_DEMO.ML.FRAUD_XGB', 'model', 'fraud-ml-eng', '{"subtitle":"XGBoost; scores fraud risk from 0 to 1"}'),
 ('fraud.decision.predictions', 'table', 'Fraud decisions', 'FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS', 'decision', 'fraud-ops', '{"subtitle":"Approve or flag, per transaction"}'),
 ('fraud.agent.fraud_watch', 'agent', 'FRAUD_WATCH agent', 'USER$ANUDEEP.PUBLIC.COCO_ROUTINE_FRAUD_WATCH', 'agent', 'fraud-ml-eng', '{}');

DELETE FROM EDGES WHERE system_id = 'fraud' AND source = 'manual';
INSERT INTO EDGES (system_id, from_id, to_id, relation, source) SELECT 'fraud', column1, column2, column3, 'manual' FROM VALUES
 ('fraud.src.transactions', 'fraud.fs.customer_spend', 'feeds'),
 ('fraud.src.customer_profile_v2', 'fraud.fs.card_spend_profile', 'feeds'),
 ('fraud.src.customers', 'fraud.fs.customer_profile', 'feeds'),
 ('fraud.src.merchants', 'fraud.fs.merchant_profile', 'feeds'),
 ('fraud.src.cards', 'fraud.fs.card_profile', 'feeds'),
 ('fraud.src.transactions', 'fraud.feat.txn_features', 'per-transaction inputs'),
 ('fraud.fs.customer_spend', 'fraud.feat.txn_features', 'joins (set v1)'),
 ('fraud.fs.card_spend_profile', 'fraud.feat.txn_features', 'joins (set v2 only)'),
 ('fraud.fs.customer_profile', 'fraud.feat.txn_features', 'joins'),
 ('fraud.fs.merchant_profile', 'fraud.feat.txn_features', 'joins'),
 ('fraud.fs.card_profile', 'fraud.feat.txn_features', 'joins'),
 ('fraud.feat.txn_features', 'fraud.model.fraud_xgb', 'inputs'),
 ('fraud.model.fraud_xgb', 'fraud.decision.predictions', 'scores become'),
 ('fraud.src.labels', 'fraud.decision.predictions', 'confirms later');

-- Metrics: generic golden signals for each component
DELETE FROM METRIC_CATALOG WHERE system_id = 'fraud';
INSERT INTO METRIC_CATALOG (metric_id, system_id, entity_id, name, unit, golden_class, kind, source_sql, expected_method, params, direction, description)
SELECT column1, 'fraud', column2, column3, column4, column5, column6, column7, column8, PARSE_JSON(column9), column10, column11 FROM VALUES
 ('fraud.decision.flag_rate', 'fraud.decision.predictions', 'Share flagged as fraud', 'share', 'output', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(is_flagged) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":4,"min_abs_delta":0.015,"min_ratio":2,"min_n":50}', 'both', 'Share of transactions the model flags'),
 ('fraud.decision.mean_score', 'fraud.model.fraud_xgb', 'Average fraud score', 'score', 'output', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(fraud_score) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":4,"min_abs_delta":0.015,"min_ratio":2,"min_n":50}', 'both', 'Average model score'),
 ('fraud.serve.volume', 'fraud.decision.predictions', 'Transactions scored', 'txns/5m', 'volume', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, COUNT(*) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS WHERE txn_ts >= :START AND txn_ts < :END AND txn_ts < DATEADD(minute,-5,CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_abs_delta":40}', 'low', 'Transactions scored per 5 minutes'),
 ('fraud.serve.freshness', 'fraud.decision.predictions', 'Minutes since last score', 'minutes', 'freshness', 'series',
  'SELECT DATE_TRUNC(minute, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) ts, DATEDIFF(minute, MAX(scored_at), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) v, 1 n FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS WHERE :START IS NOT NULL AND :END IS NOT NULL',
  'static', '{"high":15}', 'high', 'Minutes since the last prediction'),
 ('fraud.feat.null.cust_avg_amt_30d', 'fraud.feat.txn_features', 'Missing: customer 30-day avg spend', 'pct', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, 100*COUNT_IF(cust_avg_amt_30d IS NULL)/COUNT(*) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'static', '{"high":1,"min_n":50}', 'high', 'Share of transactions where this model input is empty'),
 ('fraud.feat.null.distance_from_home_km', 'fraud.feat.txn_features', 'Missing: distance from home', 'pct', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, 100*COUNT_IF(distance_from_home_km IS NULL)/COUNT(*) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'static', '{"high":1,"min_n":50}', 'high', 'Share of transactions where this model input is empty'),
 ('fraud.feat.null.merchant_risk_score', 'fraud.feat.txn_features', 'Missing: merchant risk score', 'pct', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, 100*COUNT_IF(merchant_risk_score IS NULL)/COUNT(*) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'static', '{"high":1,"min_n":50}', 'high', 'Share of transactions where this model input is empty'),
 ('fraud.feat.mean.amt_to_cust_avg_30d', 'fraud.feat.txn_features', 'Amount vs usual spend (avg)', 'ratio', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(amt_to_cust_avg_30d) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_ratio":2,"min_n":50}', 'both', 'Average value of this model input; a jump means its inputs changed'),
 ('fraud.feat.mean.txn_count_24h', 'fraud.feat.txn_features', 'Transactions in last 24 h (avg)', 'count', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(txn_count_24h) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_ratio":2,"min_n":50}', 'both', 'Average value of this model input; a jump means its inputs changed'),
 ('fraud.feat.mean.distance_from_home_km', 'fraud.feat.txn_features', 'Distance from home (avg)', 'km', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(distance_from_home_km) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_ratio":2,"min_n":50}', 'both', 'Average value of this model input; a jump means its inputs changed'),
 ('fraud.feat.mean.merchant_risk_score', 'fraud.feat.txn_features', 'Merchant risk score (avg)', 'score', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(merchant_risk_score) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_ratio":1.5,"min_n":50}', 'both', 'Average value of this model input; a jump means its inputs changed'),
 ('fraud.fs.customer_spend.freshness', 'fraud.fs.customer_spend', 'Minutes since last refresh', 'minutes', 'freshness', 'series',
  'SELECT DATE_TRUNC(minute, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) ts, DATEDIFF(minute, MAX(spend_ts), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) v, 1 n FROM FRAUD_AUTOML_DEMO.FEATURE_STORE."CUSTOMER_SPEND$V1" WHERE :START IS NOT NULL AND :END IS NOT NULL',
  'static', '{"high":15}', 'high', 'Minutes since the newest transaction in this feature view'),
 ('fraud.serve.task_failures', 'fraud.model.fraud_xgb', 'Scoring failures', 'count', 'reliability', 'event',
  'SELECT completed_time::TIMESTAMP_NTZ, 1, LEFT(error_message, 300) FROM TABLE(FRAUD_AUTOML_DEMO.INFORMATION_SCHEMA.TASK_HISTORY(SCHEDULED_TIME_RANGE_START => DATEADD(hour,-6,CURRENT_TIMESTAMP()), ERROR_ONLY => TRUE)) WHERE database_name = ''FRAUD_AUTOML_DEMO'' AND completed_time::TIMESTAMP_NTZ >= :START AND completed_time::TIMESTAMP_NTZ < :END',
  NULL, '{"severity":5}', 'high', 'Failed scoring runs');

-- Change feeds
DELETE FROM CHANGE_SOURCES WHERE system_id = 'fraud';
INSERT INTO CHANGE_SOURCES (source_id, system_id, name, source_sql) SELECT column1, 'fraud', column2, column3 FROM VALUES
 ('fraud.deploys', 'Feature set + model deploy log',
  'SELECT deployed_at, IFF(component = ''model'', ''fraud.model.fraud_xgb'', ''fraud.feat.txn_features''), component || ''_deploy'', message, version, previous_version, commit_sha, author FROM FRAUD_AUTOML_DEMO.MONITORING.PIPELINE_CHANGE_LOG WHERE deployed_at >= :START AND deployed_at < :END'),
 ('fraud.ddl', 'DDL on source / serving objects',
  'SELECT start_time::TIMESTAMP_NTZ, NULL, ''ddl:'' || query_type, LEFT(query_text, 200), NULL, NULL, query_id, user_name FROM TABLE(FRAUD_AUTOML_DEMO.INFORMATION_SCHEMA.QUERY_HISTORY(END_TIME_RANGE_START => DATEADD(hour,-6,CURRENT_TIMESTAMP()), RESULT_LIMIT => 2000)) WHERE start_time::TIMESTAMP_NTZ >= :START AND start_time::TIMESTAMP_NTZ < :END AND execution_status = ''SUCCESS'' AND query_type IN (''ALTER_TABLE'',''ALTER_TABLE_MODIFY_COLUMN'',''ALTER_TABLE_ADD_COLUMN'',''ALTER_TABLE_DROP_COLUMN'',''CREATE_TABLE'',''CREATE_TABLE_AS_SELECT'',''DROP'',''ALTER_TASK'') AND (query_text ILIKE ''%FRAUD_AUTOML_DEMO.RAW.%'' OR query_text ILIKE ''%TASK_PIPELINE_TICK%'')');

-- Slicing: which dimensions can explain an output shift
DELETE FROM SLICE_CONFIG WHERE system_id = 'fraud';
INSERT INTO SLICE_CONFIG SELECT 'fraud', 'fraud.decision.predictions',
 'SELECT p.txn_ts AS ts, p.is_flagged AS outcome, f.merchant_category, f.issuing_platform, f.home_state,
         IFF(f.is_online = 1, ''ONLINE'', ''IN_PERSON'') AS channel, TO_CHAR(f.card_issued_dt, ''YYYY-MM'') AS card_issue_month,
         p.model_version, p.feature_pipeline_version
  FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS p JOIN FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG f ON f.txn_id = p.txn_id
  WHERE p.txn_ts >= :START AND p.txn_ts < :END',
 ARRAY_CONSTRUCT('merchant_category', 'issuing_platform', 'home_state', 'channel', 'card_issue_month', 'model_version', 'feature_pipeline_version'),
 'flagged';

DELETE FROM AGENTS WHERE system_id = 'fraud';
INSERT INTO AGENTS SELECT 'fraud.agent.fraud_watch', 'fraud', 'FRAUD_WATCH',
  'USER$ANUDEEP.PUBLIC.COCO_ROUTINE_FRAUD_WATCH', 'FRAUD_AUTOML_DEMO.OPS.FRAUD_WATCH_SCOPE',
  'snow://workspace/USER$ANUDEEP.PUBLIC."DEFAULT$"/versions/live/agent_runs/fraud_watch/',
  'Detects, diagnoses (counterfactual), proposes fixes; read-only in Snowflake, PRs only';

-- Read access for the UI to the system's objects used in metric/slice SQL
GRANT USAGE ON DATABASE FRAUD_AUTOML_DEMO TO ROLE MLOPS_UI_RO;
GRANT USAGE ON ALL SCHEMAS IN DATABASE FRAUD_AUTOML_DEMO TO ROLE MLOPS_UI_RO;
GRANT SELECT ON ALL TABLES IN DATABASE FRAUD_AUTOML_DEMO TO ROLE MLOPS_UI_RO;
GRANT SELECT ON ALL VIEWS IN DATABASE FRAUD_AUTOML_DEMO TO ROLE MLOPS_UI_RO;
GRANT SELECT ON ALL DYNAMIC TABLES IN SCHEMA FRAUD_AUTOML_DEMO.FEATURE_STORE TO ROLE MLOPS_UI_RO;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FRAUD_AUTOML_DEMO.FEATURE_STORE TO ROLE MLOPS_UI_RO;
GRANT SELECT ON FUTURE DYNAMIC TABLES IN SCHEMA FRAUD_AUTOML_DEMO.FEATURE_STORE TO ROLE MLOPS_UI_RO;
