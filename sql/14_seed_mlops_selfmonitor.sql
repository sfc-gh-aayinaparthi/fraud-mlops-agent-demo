-- 14 Generality check: a second, unrelated system registered purely as configuration.
-- The control plane monitors itself (real task and table data); no app code changes.
USE ROLE ACCOUNTADMIN;
USE SCHEMA MLOPS_CONTROL.CORE;

DELETE FROM SYSTEMS WHERE system_id = 'mlops';
INSERT INTO SYSTEMS SELECT 'mlops', 'MLOps control plane', 'Signal evaluation, incident correlation and agent trace ingestion',
  'platform-eng', NULL, NULL, PARSE_JSON('{}'), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

DELETE FROM ENTITIES WHERE system_id = 'mlops';
INSERT INTO ENTITIES SELECT column1, 'mlops', column2, column3, column4, column5, 'platform-eng', PARSE_JSON('{}') FROM VALUES
 ('mlops.src.catalog', 'table', 'Metric catalog', 'MLOPS_CONTROL.CORE.METRIC_CATALOG', 'source'),
 ('mlops.src.workspace', 'stage', 'Agent workspaces', 'snow://workspace', 'source'),
 ('mlops.task.evaluate', 'task', 'Evaluator task', 'MLOPS_CONTROL.CORE.TASK_CONTROL_PLANE', 'serving'),
 ('mlops.task.loader', 'task', 'Trace loader task', 'MLOPS_CONTROL.CORE.TASK_LOAD_AGENT_EVENTS', 'serving'),
 ('mlops.tbl.signals', 'table', 'Signals', 'MLOPS_CONTROL.CORE.SIGNALS', 'decision'),
 ('mlops.tbl.events', 'table', 'Agent events', 'MLOPS_CONTROL.CORE.AGENT_EVENTS', 'decision');

DELETE FROM EDGES WHERE system_id = 'mlops';
INSERT INTO EDGES (system_id, from_id, to_id, relation, source) SELECT 'mlops', column1, column2, column3, 'manual' FROM VALUES
 ('mlops.src.catalog', 'mlops.task.evaluate', 'configures'),
 ('mlops.task.evaluate', 'mlops.tbl.signals', 'writes'),
 ('mlops.src.workspace', 'mlops.task.loader', 'reads'),
 ('mlops.task.loader', 'mlops.tbl.events', 'writes');

DELETE FROM METRIC_CATALOG WHERE system_id = 'mlops';
INSERT INTO METRIC_CATALOG (metric_id, system_id, entity_id, name, unit, golden_class, kind, source_sql, expected_method, params, direction, description)
SELECT column1, 'mlops', column2, column3, column4, column5, column6, column7, column8, PARSE_JSON(column9), column10, column11 FROM VALUES
 ('mlops.signals.freshness', 'mlops.tbl.signals', 'Evaluation freshness', 'minutes', 'freshness', 'series',
  'SELECT DATE_TRUNC(minute, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) ts, DATEDIFF(minute, MAX(evaluated_at), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) v, 1 n FROM MLOPS_CONTROL.CORE.SIGNALS WHERE :START IS NOT NULL AND :END IS NOT NULL',
  'static', '{"high":12}', 'high', 'Minutes since signals were last evaluated'),
 ('mlops.signals.volume', 'mlops.task.evaluate', 'Signals written', 'rows/5m', 'volume', 'series',
  'SELECT TIME_SLICE(evaluated_at, 5, ''MINUTE'') ts, COUNT(*) v, COUNT(*) n FROM MLOPS_CONTROL.CORE.SIGNALS WHERE system_id <> ''mlops'' AND evaluated_at >= :START AND evaluated_at < :END GROUP BY 1',
  'static', '{"low":1}', 'low', 'Signal rows upserted per 5 minutes'),
 ('mlops.task.failures', 'mlops.task.evaluate', 'Control-plane task failures', 'count', 'reliability', 'event',
  'SELECT completed_time::TIMESTAMP_NTZ, 1, name || '': '' || LEFT(error_message, 250) FROM TABLE(MLOPS_CONTROL.INFORMATION_SCHEMA.TASK_HISTORY(SCHEDULED_TIME_RANGE_START => DATEADD(hour,-6,CURRENT_TIMESTAMP()), ERROR_ONLY => TRUE)) WHERE completed_time::TIMESTAMP_NTZ >= :START AND completed_time::TIMESTAMP_NTZ < :END',
  NULL, '{"severity":4}', 'high', 'Failed runs of control-plane tasks');
