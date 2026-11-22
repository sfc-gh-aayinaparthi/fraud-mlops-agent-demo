-- 11 Agent trace loader: agents append JSONL span events to their sandbox workspace;
-- this copies new trace files into an internal stage and merges them into AGENT_EVENTS.
-- Event line schema (one JSON object per line):
--   {"run_id","seq","ts" (UTC, YYYY-MM-DD HH:MI:SS),"kind","name","status","entity_id","incident_id","attributes":{...}}
USE ROLE ACCOUNTADMIN;
USE SCHEMA MLOPS_CONTROL.CORE;
USE WAREHOUSE FRAUD_WH;

CREATE FILE FORMAT IF NOT EXISTS FF_LINES TYPE = CSV FIELD_DELIMITER = NONE RECORD_DELIMITER = '\n'
  ESCAPE_UNENCLOSED_FIELD = NONE;
CREATE STAGE IF NOT EXISTS AGENT_TRACES DIRECTORY = (ENABLE = TRUE);

CREATE OR REPLACE PROCEDURE LOAD_AGENT_EVENTS()
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
  n NUMBER DEFAULT 0;
  c CURSOR FOR SELECT agent_id, trace_path FROM MLOPS_CONTROL.CORE.AGENTS WHERE trace_path IS NOT NULL;
BEGIN
  FOR rec IN c DO
    LET aid STRING := rec.agent_id;
    LET src STRING := rec.trace_path;
    BEGIN
      EXECUTE IMMEDIATE 'COPY FILES INTO @MLOPS_CONTROL.CORE.AGENT_TRACES/' || :aid || '/ FROM ''' || :src || '''';
    EXCEPTION
      WHEN OTHER THEN NULL;   -- no trace files yet
    END;
  END FOR;
  ALTER STAGE MLOPS_CONTROL.CORE.AGENT_TRACES REFRESH;

  MERGE INTO MLOPS_CONTROL.CORE.AGENT_EVENTS t
  USING (
    SELECT SPLIT_PART(METADATA$FILENAME, '/', 1) AS agent_id,
           TRY_PARSE_JSON($1) AS j, METADATA$FILENAME AS f
    FROM @MLOPS_CONTROL.CORE.AGENT_TRACES (FILE_FORMAT => 'MLOPS_CONTROL.CORE.FF_LINES', PATTERN => '.*\\.jsonl')
    QUALIFY j IS NOT NULL
        AND ROW_NUMBER() OVER (PARTITION BY j:run_id::STRING, j:seq::NUMBER ORDER BY f) = 1
  ) s
  ON t.run_id = s.j:run_id::STRING AND t.seq = s.j:seq::NUMBER
  WHEN NOT MATCHED AND s.j:run_id IS NOT NULL THEN INSERT
    (agent_id, run_id, seq, ts, kind, name, status, entity_id, incident_id, attributes, source_file)
  VALUES (s.agent_id, s.j:run_id::STRING, s.j:seq::NUMBER,
          COALESCE(TRY_TO_TIMESTAMP_LTZ(s.j:ts::STRING || ' +0000', 'YYYY-MM-DD HH24:MI:SS TZHTZM')::TIMESTAMP_NTZ, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ),
          s.j:kind::STRING, s.j:name::STRING, s.j:status::STRING, s.j:entity_id::STRING,
          s.j:incident_id::STRING, s.j:attributes, s.f);
  n := SQLROWCOUNT;
  RETURN 'loaded ' || n || ' events';
END;
$$;
