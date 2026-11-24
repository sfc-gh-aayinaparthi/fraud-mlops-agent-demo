-- 14 Generality check: a second, unrelated system registered purely as configuration.
-- The control plane monitors itself (real task and table data); no app code changes.
USE ROLE ACCOUNTADMIN;
USE SCHEMA MLOPS_CONTROL.CORE;

DELETE FROM SYSTEMS WHERE system_id = 'mlops';
INSERT INTO SYSTEMS SELECT 'mlops', 'MLOps control plane', 'The monitoring platform itself: health checks, incident detection and agent logs',
  'platform-eng', NULL, NULL, PARSE_JSON('{}'), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

DELETE FROM ENTITIES WHERE system_id = 'mlops';
INSERT INTO ENTITIES SELECT column1, 'mlops', column2, column3, column4, column5, 'platform-eng', PARSE_JSON(column6) FROM VALUES
 ('mlops.src.catalog', 'table', 'Health-check definitions', 'MLOPS_CONTROL.CORE.METRIC_CATALOG', 'source', '{"subtitle":"What to measure for each component"}'),
 ('mlops.src.workspace', 'stage', 'Agent run files', 'snow://workspace', 'source', '{"subtitle":"Step-by-step logs the agent writes"}'),
 ('mlops.task.evaluate', 'task', 'Health checker', 'MLOPS_CONTROL.CORE.TASK_CONTROL_PLANE', 'serving', '{"subtitle":"Every 5 min, runs all health checks"}'),
 ('mlops.task.loader', 'task', 'Agent log loader', 'MLOPS_CONTROL.CORE.TASK_LOAD_AGENT_EVENTS', 'serving', '{"subtitle":"Every minute, loads new agent logs"}'),
 ('mlops.tbl.signals', 'table', 'Health readings', 'MLOPS_CONTROL.CORE.SIGNALS', 'decision', '{"subtitle":"Latest value vs normal for every check"}'),
 ('mlops.tbl.events', 'table', 'Agent activity', 'MLOPS_CONTROL.CORE.AGENT_EVENTS', 'decision', '{"subtitle":"What each agent run did"}');

DELETE FROM EDGES WHERE system_id = 'mlops';
INSERT INTO EDGES (system_id, from_id, to_id, relation, source) SELECT 'mlops', column1, column2, column3, 'manual' FROM VALUES
 ('mlops.src.catalog', 'mlops.task.evaluate', 'configures'),
 ('mlops.task.evaluate', 'mlops.tbl.signals', 'writes'),
 ('mlops.src.workspace', 'mlops.task.loader', 'reads'),
 ('mlops.task.loader', 'mlops.tbl.events', 'writes');

DELETE FROM METRIC_CATALOG WHERE system_id = 'mlops';
INSERT INTO METRIC_CATALOG (metric_id, system_id, entity_id, name, unit, golden_class, kind, source_sql, expected_method, params, direction, description)
SELECT column1, 'mlops', column2, column3, column4, column5, column6, column7, column8, PARSE_JSON(column9), column10, column11 FROM VALUES
 ('mlops.signals.freshness', 'mlops.tbl.signals', 'Minutes since last health check', 'minutes', 'freshness', 'series',
  'SELECT DATE_TRUNC(minute, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) ts, DATEDIFF(minute, MAX(evaluated_at), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) v, 1 n FROM MLOPS_CONTROL.CORE.SIGNALS WHERE :START IS NOT NULL AND :END IS NOT NULL',
  'static', '{"high":12}', 'high', 'Minutes since health checks last ran'),
 ('mlops.signals.volume', 'mlops.task.evaluate', 'Health readings written', 'rows/5m', 'volume', 'series',
  'SELECT TIME_SLICE(evaluated_at, 5, ''MINUTE'') ts, COUNT(*) v, COUNT(*) n FROM MLOPS_CONTROL.CORE.SIGNALS WHERE system_id <> ''mlops'' AND evaluated_at >= :START AND evaluated_at < :END GROUP BY 1',
  'static', '{"low":1}', 'low', 'Health readings written per 5 minutes'),
 ('mlops.task.failures', 'mlops.task.evaluate', 'Platform job failures', 'count', 'reliability', 'event',
  'SELECT completed_time::TIMESTAMP_NTZ, 1, name || '': '' || LEFT(error_message, 250) FROM TABLE(MLOPS_CONTROL.INFORMATION_SCHEMA.TASK_HISTORY(SCHEDULED_TIME_RANGE_START => DATEADD(hour,-6,CURRENT_TIMESTAMP()), ERROR_ONLY => TRUE)) WHERE database_name = ''MLOPS_CONTROL'' AND completed_time::TIMESTAMP_NTZ >= :START AND completed_time::TIMESTAMP_NTZ < :END',
  NULL, '{"severity":4}', 'high', 'Failed runs of the platform''s scheduled jobs');
