-- 12 Scheduling for the agent trace loader + an owner's-rights wrapper the UI calls
-- to trigger an agent run (the app role gets USAGE on this proc only).
USE ROLE ACCOUNTADMIN;
USE SCHEMA MLOPS_CONTROL.CORE;

CREATE OR REPLACE TASK TASK_LOAD_AGENT_EVENTS
  WAREHOUSE = FRAUD_WH
  SCHEDULE = '1 MINUTE'
AS CALL MLOPS_CONTROL.CORE.LOAD_AGENT_EVENTS();

-- Run an agent now. Owner's rights so the app needs no direct privilege on the task.
CREATE OR REPLACE PROCEDURE RUN_AGENT(AGENT STRING, REQUESTED_BY STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  t STRING;
  sid STRING;
BEGIN
  SELECT task_fqn, system_id INTO :t, :sid FROM MLOPS_CONTROL.CORE.AGENTS WHERE agent_id = :AGENT;
  IF (:t IS NULL) THEN
    RETURN 'unknown agent';
  END IF;
  EXECUTE IMMEDIATE 'EXECUTE TASK ' || :t;
  INSERT INTO MLOPS_CONTROL.CORE.ACTION_LOG (actor, action, target, system_id, outcome)
    VALUES (:REQUESTED_BY, 'run_agent', :AGENT, :sid, 'executed');
  RETURN 'started ' || :t;
END;
$$;

-- Refresh traces on demand (live view) without waiting for the 1-minute task
CREATE OR REPLACE PROCEDURE REFRESH_AGENT_EVENTS()
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
  CALL MLOPS_CONTROL.CORE.LOAD_AGENT_EVENTS();
  RETURN 'ok';
END;
$$;
