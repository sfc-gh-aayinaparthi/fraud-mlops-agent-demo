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
 ('fraud.src.transactions', 'table', 'Transactions', 'FRAUD_AUTOML_DEMO.RAW.TRANSACTIONS', 'source', 'payments-platform', '{}'),
 ('fraud.src.customers', 'table', 'Customers', 'FRAUD_AUTOML_DEMO.RAW.CUSTOMERS', 'source', 'customer-data', '{}'),
 ('fraud.src.cards', 'table', 'Cards', 'FRAUD_AUTOML_DEMO.RAW.CARDS', 'source', 'card-platform', '{}'),
 ('fraud.src.merchants', 'table', 'Merchants', 'FRAUD_AUTOML_DEMO.RAW.MERCHANTS', 'source', 'merchant-risk', '{}'),
 ('fraud.src.customer_profile_v2', 'table', 'Customer profile v2', 'FRAUD_AUTOML_DEMO.RAW.CUSTOMER_PROFILE_V2', 'source', 'customer-data', '{}'),
 ('fraud.src.labels', 'table', 'Fraud labels', 'FRAUD_AUTOML_DEMO.RAW.FRAUD_LABELS', 'source', 'fraud-ops', '{}'),
 ('fraud.feat.txn_features', 'feature_pipeline', 'Txn feature pipeline', 'FRAUD_AUTOML_DEMO.FEATURES.FN_TXN_FEATURES', 'feature', 'fraud-data-eng', '{"replayable": true}'),
 ('fraud.feat.feature_log', 'table', 'Served feature log', 'FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG', 'feature', 'fraud-ml-eng', '{}'),
 ('fraud.model.fraud_xgb', 'model', 'FRAUD_XGB', 'FRAUD_AUTOML_DEMO.ML.FRAUD_XGB', 'model', 'fraud-ml-eng', '{}'),
 ('fraud.serve.scoring', 'task', 'Scoring task', 'FRAUD_AUTOML_DEMO.OPS.TASK_PIPELINE_TICK', 'serving', 'fraud-ml-eng', '{}'),
 ('fraud.decision.predictions', 'table', 'Decisions', 'FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS', 'decision', 'fraud-ops', '{}'),
 ('fraud.agent.fraud_watch', 'agent', 'FRAUD_WATCH agent', 'USER$ANUDEEP.PUBLIC.COCO_ROUTINE_FRAUD_WATCH', 'agent', 'fraud-ml-eng', '{}');

DELETE FROM EDGES WHERE system_id = 'fraud' AND source = 'manual';
INSERT INTO EDGES (system_id, from_id, to_id, relation, source) SELECT 'fraud', column1, column2, column3, 'manual' FROM VALUES
 ('fraud.src.transactions', 'fraud.feat.txn_features', 'reads'),
 ('fraud.src.customers', 'fraud.feat.txn_features', 'reads'),
 ('fraud.src.cards', 'fraud.feat.txn_features', 'reads'),
 ('fraud.src.merchants', 'fraud.feat.txn_features', 'reads'),
 ('fraud.src.customer_profile_v2', 'fraud.feat.txn_features', 'reads (v2)'),
 ('fraud.feat.txn_features', 'fraud.feat.feature_log', 'writes'),
 ('fraud.feat.feature_log', 'fraud.model.fraud_xgb', 'scored by'),
 ('fraud.model.fraud_xgb', 'fraud.serve.scoring', 'invoked by'),
 ('fraud.serve.scoring', 'fraud.decision.predictions', 'writes'),
 ('fraud.src.labels', 'fraud.decision.predictions', 'labels');

-- Metrics: generic golden signals for each component
DELETE FROM METRIC_CATALOG WHERE system_id = 'fraud';
INSERT INTO METRIC_CATALOG (metric_id, system_id, entity_id, name, unit, golden_class, kind, source_sql, expected_method, params, direction, description)
SELECT column1, 'fraud', column2, column3, column4, column5, column6, column7, column8, PARSE_JSON(column9), column10, column11 FROM VALUES
 ('fraud.decision.flag_rate', 'fraud.decision.predictions', 'Flag rate', 'ratio', 'output', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(is_flagged) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":4,"min_abs_delta":0.015,"min_ratio":2,"min_n":50}', 'both', 'Share of transactions the model flags'),
 ('fraud.decision.mean_score', 'fraud.decision.predictions', 'Mean fraud score', 'score', 'output', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(fraud_score) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":4,"min_abs_delta":0.015,"min_ratio":2,"min_n":50}', 'both', 'Average model score'),
 ('fraud.serve.volume', 'fraud.serve.scoring', 'Scored volume', 'txns/5m', 'volume', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, COUNT(*) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS WHERE txn_ts >= :START AND txn_ts < :END AND txn_ts < DATEADD(minute,-5,CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_abs_delta":40}', 'low', 'Transactions scored per 5 minutes'),
 ('fraud.serve.freshness', 'fraud.serve.scoring', 'Scoring freshness', 'minutes', 'freshness', 'series',
  'SELECT DATE_TRUNC(minute, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) ts, DATEDIFF(minute, MAX(scored_at), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) v, 1 n FROM FRAUD_AUTOML_DEMO.SERVING.PREDICTIONS WHERE :START IS NOT NULL AND :END IS NOT NULL',
  'static', '{"high":15}', 'high', 'Minutes since the last prediction'),
 ('fraud.feat.null.cust_avg_amt_30d', 'fraud.feat.feature_log', 'Null % cust_avg_amt_30d', 'pct', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, 100*COUNT_IF(cust_avg_amt_30d IS NULL)/COUNT(*) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'static', '{"high":1,"min_n":50}', 'high', 'Null rate of an input feature'),
 ('fraud.feat.null.distance_from_home_km', 'fraud.feat.feature_log', 'Null % distance_from_home_km', 'pct', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, 100*COUNT_IF(distance_from_home_km IS NULL)/COUNT(*) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'static', '{"high":1,"min_n":50}', 'high', 'Null rate of an input feature'),
 ('fraud.feat.null.merchant_risk_score', 'fraud.feat.feature_log', 'Null % merchant_risk_score', 'pct', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, 100*COUNT_IF(merchant_risk_score IS NULL)/COUNT(*) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'static', '{"high":1,"min_n":50}', 'high', 'Null rate of an input feature'),
 ('fraud.feat.mean.amt_to_cust_avg_30d', 'fraud.feat.feature_log', 'Mean amt_to_cust_avg_30d', 'ratio', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(amt_to_cust_avg_30d) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_ratio":2,"min_n":50}', 'both', 'Distribution shift of an input feature'),
 ('fraud.feat.mean.txn_count_24h', 'fraud.feat.feature_log', 'Mean txn_count_24h', 'count', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(txn_count_24h) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_ratio":2,"min_n":50}', 'both', 'Distribution shift of an input feature'),
 ('fraud.feat.mean.distance_from_home_km', 'fraud.feat.feature_log', 'Mean distance_from_home_km', 'km', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(distance_from_home_km) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_ratio":2,"min_n":50}', 'both', 'Distribution shift of an input feature'),
 ('fraud.feat.mean.merchant_risk_score', 'fraud.feat.feature_log', 'Mean merchant_risk_score', 'score', 'data_quality', 'series',
  'SELECT TIME_SLICE(txn_ts, 5, ''MINUTE'') ts, AVG(merchant_risk_score) v, COUNT(*) n FROM FRAUD_AUTOML_DEMO.SERVING.FEATURE_LOG WHERE txn_ts >= :START AND txn_ts < :END GROUP BY 1',
  'same_hour_baseline', '{"k":5,"min_ratio":1.5,"min_n":50}', 'both', 'Distribution shift of an input feature'),
 ('fraud.serve.task_failures', 'fraud.serve.scoring', 'Pipeline task failures', 'count', 'reliability', 'event',
  'SELECT completed_time::TIMESTAMP_NTZ, 1, LEFT(error_message, 300) FROM TABLE(FRAUD_AUTOML_DEMO.INFORMATION_SCHEMA.TASK_HISTORY(SCHEDULED_TIME_RANGE_START => DATEADD(hour,-6,CURRENT_TIMESTAMP()), ERROR_ONLY => TRUE)) WHERE completed_time::TIMESTAMP_NTZ >= :START AND completed_time::TIMESTAMP_NTZ < :END',
  NULL, '{"severity":5}', 'high', 'Failed runs of the pipeline task');

-- Change feeds
DELETE FROM CHANGE_SOURCES WHERE system_id = 'fraud';
INSERT INTO CHANGE_SOURCES (source_id, system_id, name, source_sql) SELECT column1, 'fraud', column2, column3 FROM VALUES
 ('fraud.deploys', 'Pipeline + model deploy log',
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
