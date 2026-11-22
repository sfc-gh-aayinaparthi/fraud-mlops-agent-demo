-- 10 Generic Git -> Snowflake continuous deployment per component.
-- Contract: COMPONENT_DEPLOY.deploy_procedure has signature
--   (VERSION STRING, COMMIT_SHA STRING, AUTHOR STRING, MESSAGE STRING, SOURCE STRING)
USE ROLE ACCOUNTADMIN;
USE SCHEMA MLOPS_CONTROL.CORE;
USE WAREHOUSE FRAUD_WH;

CREATE API INTEGRATION IF NOT EXISTS MLOPS_GITHUB_API
  API_PROVIDER = git_https_api
  API_ALLOWED_PREFIXES = ('https://github.com/sfc-gh-aayinaparthi/')
  ENABLED = TRUE;

CREATE GIT REPOSITORY IF NOT EXISTS MLOPS_CONTROL.CORE.REPO_FRAUD_MLOPS
  API_INTEGRATION = MLOPS_GITHUB_API
  ORIGIN = 'https://github.com/sfc-gh-aayinaparthi/fraud-mlops-agent-demo.git';

CREATE OR REPLACE PROCEDURE DEPLOY_FROM_GIT(ENTITY STRING, FORCE BOOLEAN DEFAULT FALSE)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
EXECUTE AS CALLER
AS
$$
import re

def run(session, entity, force):
    cfg = session.sql("SELECT * FROM MLOPS_CONTROL.CORE.COMPONENT_DEPLOY WHERE entity_id = ?", params=[entity]).collect()
    if not cfg:
        raise ValueError(f"no deploy hook for {entity}")
    c = cfg[0]
    repo, branch = c["GIT_REPO"], c["BRANCH"]
    session.sql(f"ALTER GIT REPOSITORY {repo} FETCH").collect()
    sha = None
    for b in session.sql(f"SHOW GIT BRANCHES IN {repo}").collect():
        if b["name"] == branch:
            sha = b["commit_hash"]
    with session.file.get_stream(f"@{repo}/branches/{branch}/{c['PATH']}") as f:
        source = f.read().decode("utf-8")
    m = re.search(c["VERSION_REGEX"], source)
    if not m:
        raise ValueError("version marker not found in source")
    version = m.group(1).upper()
    active = session.sql(c["ACTIVE_VERSION_SQL"]).collect()[0][0]
    if not force and active and active.upper() == version:
        return f"no-op: {entity} already at {version} (main @ {sha[:7] if sha else '?'})"
    res = session.sql(f"CALL {c['DEPLOY_PROCEDURE']}(?, ?, ?, ?, ?)",
                      params=[version, (sha or "")[:7], "cd:" + branch, f"Deployed {branch} @ {(sha or '')[:7]}", source]).collect()[0][0]
    session.sql("""INSERT INTO MLOPS_CONTROL.CORE.ACTION_LOG (actor, action, target, system_id, details, outcome)
                   SELECT CURRENT_USER(), 'deploy', ?, ?, PARSE_JSON(?), 'executed'""",
                params=[entity, c["SYSTEM_ID"], f'{{"version":"{version}","previous":"{active}","sha":"{sha}"}}']).collect()
    return f"{res} from {branch} @ {(sha or '')[:7]}"
$$;

-- Continuous deployment: any merge to main (UI or GitHub) is picked up within a minute
CREATE OR REPLACE PROCEDURE DEPLOY_ALL_FROM_GIT()
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
  out STRING DEFAULT '';
  r STRING;
  c CURSOR FOR SELECT entity_id FROM MLOPS_CONTROL.CORE.COMPONENT_DEPLOY;
BEGIN
  FOR rec IN c DO
    LET e STRING := rec.entity_id;
    CALL MLOPS_CONTROL.CORE.DEPLOY_FROM_GIT(:e, FALSE) INTO :r;
    out := out || :e || ': ' || :r || '; ';
  END FOR;
  RETURN out;
END;
$$;

CREATE OR REPLACE TASK TASK_CONTINUOUS_DEPLOY
  WAREHOUSE = FRAUD_WH
  SCHEDULE = '1 MINUTE'
AS CALL MLOPS_CONTROL.CORE.DEPLOY_ALL_FROM_GIT();

-- fraud system hook (configuration)
DELETE FROM COMPONENT_DEPLOY WHERE entity_id = 'fraud.feat.txn_features';
INSERT INTO COMPONENT_DEPLOY VALUES ('fraud.feat.txn_features', 'fraud', 'MLOPS_CONTROL.CORE.REPO_FRAUD_MLOPS', 'main',
  'pipeline/features/features_txn.sql', '-- VERSION: (\\w+)',
  'FRAUD_AUTOML_DEMO.OPS.DEPLOY_FEATURE_PIPELINE',
  'SELECT MAX(version) FROM FRAUD_AUTOML_DEMO.OPS.ACTIVE_COMPONENTS WHERE component = ''feature_pipeline''');
