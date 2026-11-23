-- 13 Actions: proposals view, policy-gated executor (GitHub via External Access), human verdicts.
USE ROLE ACCOUNTADMIN;
USE SCHEMA MLOPS_CONTROL.CORE;
USE WAREHOUSE FRAUD_WH;

-- GitHub credentials for executors. Replace the placeholder with a fine-grained PAT
-- (this repo only: Contents RW, Pull requests RW):
--   ALTER SECRET MLOPS_CONTROL.CORE.GITHUB_PAT SET SECRET_STRING = '<token>';
CREATE SECRET IF NOT EXISTS GITHUB_PAT TYPE = GENERIC_STRING SECRET_STRING = 'replace-me';

CREATE OR REPLACE NETWORK RULE GITHUB_API_RULE MODE = EGRESS TYPE = HOST_PORT VALUE_LIST = ('api.github.com');
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION MLOPS_GITHUB_EAI
  ALLOWED_NETWORK_RULES = (MLOPS_CONTROL.CORE.GITHUB_API_RULE)
  ALLOWED_AUTHENTICATION_SECRETS = (MLOPS_CONTROL.CORE.GITHUB_PAT)
  ENABLED = TRUE;

-- Proposals emitted by agents, with their human decision (if any)
CREATE OR REPLACE VIEW V_PROPOSALS AS
WITH p AS (
  SELECT e.agent_id, e.run_id, e.seq, e.run_id || ':' || e.seq AS proposal_id, e.ts AS proposed_at,
         e.incident_id, a.system_id, e.attributes:action_type::STRING AS action_type,
         e.attributes:params AS params, e.attributes:rationale::STRING AS rationale, e.status AS agent_status
  FROM AGENT_EVENTS e JOIN AGENTS a ON a.agent_id = e.agent_id
  WHERE e.kind = 'proposal'
), d AS (
  SELECT proposal_id, actor AS decided_by, ts AS decided_at, outcome, details
  FROM ACTION_LOG WHERE proposal_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY proposal_id ORDER BY ts DESC) = 1
)
SELECT p.*, t.description AS action_description, t.requires_approval, t.approver_role, t.rollback,
       COALESCE(d.outcome, IFF(p.agent_status = 'executed', 'executed_by_agent',
                IFF(t.requires_approval, 'awaiting_approval', 'auto'))) AS status,
       d.decided_by, d.decided_at, d.details AS decision_details
FROM p LEFT JOIN ACTION_TYPES t ON t.action_type = p.action_type LEFT JOIN d ON d.proposal_id = p.proposal_id;

-- Execute or reject a proposal. USAGE is granted to MLOPS_APPROVER only, so the
-- privilege system enforces the approval policy; the caller is recorded.
CREATE OR REPLACE PROCEDURE EXECUTE_ACTION(PROPOSAL_ID STRING, DECISION STRING, NOTE STRING)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'requests')
HANDLER = 'run'
EXTERNAL_ACCESS_INTEGRATIONS = (MLOPS_GITHUB_EAI)
SECRETS = ('pat' = MLOPS_CONTROL.CORE.GITHUB_PAT)
EXECUTE AS OWNER
AS
$$
import json, re
import requests
import _snowflake

def gh(method, path, body=None):
    tok = _snowflake.get_generic_secret_string("pat")
    r = requests.request(method, "https://api.github.com" + path, timeout=30, json=body,
                         headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"})
    return r.status_code, (r.json() if r.content else {})

def run(session, proposal_id, decision, note):
    actor = session.sql("SELECT CURRENT_USER()").collect()[0][0]
    rows = session.sql("SELECT * FROM MLOPS_CONTROL.CORE.V_PROPOSALS WHERE proposal_id = ?", params=[proposal_id]).collect()
    if not rows:
        return {"ok": False, "error": "unknown proposal"}
    p = rows[0]
    if p["STATUS"] not in ("awaiting_approval", "auto", "failed"):   # failed may be retried
        return {"ok": False, "error": f"proposal already {p['STATUS']}"}
    params = json.loads(p["PARAMS"]) if p["PARAMS"] else {}
    atype = p["ACTION_TYPE"]
    repo = session.sql("SELECT repo_url FROM MLOPS_CONTROL.CORE.SYSTEMS WHERE system_id = ?", params=[p["SYSTEM_ID"]]).collect()[0][0] or ""
    m = re.search(r"github\.com/([^/]+/[^/.]+)", repo)
    slug = m.group(1) if m else None
    result, outcome = {}, "executed"
    decision = (decision or "").lower()
    try:
        if decision == "reject":
            outcome = "rejected"
            if atype == "merge_pr" and slug and params.get("pr_number"):
                code, body = gh("PATCH", f"/repos/{slug}/pulls/{int(params['pr_number'])}", {"state": "closed"})
                result = {"github_status": code, "state": body.get("state")}
        elif decision == "approve":
            if atype == "merge_pr":
                n = int(params["pr_number"])
                code, body = gh("PUT", f"/repos/{slug}/pulls/{n}/merge",
                                {"merge_method": "squash", "commit_title": f"Merge #{n} (approved by {actor} in Mission Control)"})
                result = {"github_status": code, "merged": body.get("merged"), "message": body.get("message"), "sha": body.get("sha")}
                if code != 200:
                    outcome = "failed"
                else:
                    deploys = []
                    for c in session.sql("SELECT entity_id FROM MLOPS_CONTROL.CORE.COMPONENT_DEPLOY WHERE system_id = ?",
                                         params=[p["SYSTEM_ID"]]).collect():
                        deploys.append(session.sql("CALL MLOPS_CONTROL.CORE.DEPLOY_FROM_GIT(?, FALSE)", params=[c[0]]).collect()[0][0])
                    result["deploys"] = deploys
            elif atype == "rollback_model_default":
                model, version = params["model"], params["version"]
                if not re.match(r"^[A-Za-z0-9_.$]+$", model) or not re.match(r"^[A-Za-z0-9_]+$", version):
                    raise ValueError("bad model/version")
                session.sql(f"ALTER MODEL {model} SET DEFAULT_VERSION = {version}").collect()
                result = {"model": model, "default_version": version}
            elif atype == "set_feature_set":
                version = str(params["version"])
                if not re.match(r"^[A-Za-z0-9_]+$", version):
                    raise ValueError("bad feature set version")
                res = session.sql("CALL FRAUD_AUTOML_DEMO.OPS.ACTIVATE_FEATURE_SET(?, ?, ?)",
                                  params=[version, actor, note or p["RATIONALE"] or ""]).collect()[0][0]
                if res.startswith("error"):
                    raise ValueError(res)
                result = {"feature_set": version.upper(), "message": res}
            elif atype == "suspend_task":
                task = params["task"]
                if not re.match(r"^[A-Za-z0-9_.$\"]+$", task):
                    raise ValueError("bad task name")
                session.sql(f"ALTER TASK {task} SUSPEND").collect()
                result = {"task": task, "state": "suspended"}
            elif atype in ("escalate", "open_pr"):
                result = {"acknowledged": True}
            else:
                raise ValueError(f"no executor for {atype}")
        else:
            return {"ok": False, "error": "decision must be approve or reject"}
    except Exception as ex:
        outcome, result = "failed", {"error": str(ex)[:300]}
    session.sql("""INSERT INTO MLOPS_CONTROL.CORE.ACTION_LOG (actor, action, target, system_id, incident_id, proposal_id, details, outcome)
                   SELECT ?, ?, ?, ?, ?, ?, PARSE_JSON(?), ?""",
                params=[actor, f"{decision}:{atype}", json.dumps(params), p["SYSTEM_ID"], p["INCIDENT_ID"], proposal_id,
                        json.dumps({"note": note, "result": result}), outcome]).collect()
    return {"ok": outcome != "failed", "outcome": outcome, "result": result}
$$;

-- Engineer feedback on the agent's verdict (feeds agent accuracy)
CREATE OR REPLACE PROCEDURE SET_HUMAN_VERDICT(INCIDENT STRING, VERDICT STRING, NOTE STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
  IF (:VERDICT NOT IN ('correct', 'partially_correct', 'wrong', 'not_an_incident')) THEN
    RETURN 'invalid verdict';
  END IF;
  UPDATE MLOPS_CONTROL.CORE.INCIDENTS SET human_verdict = :VERDICT, human_note = :NOTE,
         human_by = CURRENT_USER(), human_at = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
  WHERE incident_id = :INCIDENT;
  INSERT INTO MLOPS_CONTROL.CORE.ACTION_LOG (actor, action, target, incident_id, details, outcome)
    SELECT CURRENT_USER(), 'verdict', :INCIDENT, :INCIDENT, OBJECT_CONSTRUCT('verdict', :VERDICT, 'note', :NOTE), 'recorded';
  RETURN 'recorded';
END;
$$;

-- Link agent conclusions to incidents (run on the control-plane schedule)
CREATE OR REPLACE PROCEDURE SYNC_AGENT_VERDICTS()
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
  UPDATE MLOPS_CONTROL.CORE.INCIDENTS i SET agent_verdict = r.verdict, agent_cause = r.cause, agent_run_id = r.run_id
  FROM (SELECT incident_id, run_id, attributes:verdict::STRING verdict, attributes:cause::STRING cause
        FROM MLOPS_CONTROL.CORE.AGENT_EVENTS WHERE kind = 'run_end' AND incident_id IS NOT NULL
        QUALIFY ROW_NUMBER() OVER (PARTITION BY incident_id ORDER BY ts DESC) = 1) r
  WHERE r.incident_id = i.incident_id;
  RETURN 'ok';
END;
$$;

CREATE OR REPLACE TASK TASK_CONTROL_PLANE
  WAREHOUSE = FRAUD_WH
  SCHEDULE = '5 MINUTE'
AS
EXECUTE IMMEDIATE $$
BEGIN
  CALL MLOPS_CONTROL.CORE.EVALUATE_METRICS(60);
  CALL MLOPS_CONTROL.CORE.SYNC_CHANGES(180);
  CALL MLOPS_CONTROL.CORE.CORRELATE_INCIDENTS(30, 15);
  CALL MLOPS_CONTROL.CORE.SYNC_AGENT_VERDICTS();
END;
$$;
ALTER TASK TASK_CONTROL_PLANE RESUME;

GRANT USAGE ON PROCEDURE EXECUTE_ACTION(STRING, STRING, STRING) TO ROLE MLOPS_APPROVER;
GRANT USAGE ON PROCEDURE SET_HUMAN_VERDICT(STRING, STRING, STRING) TO ROLE MLOPS_APPROVER;
GRANT USAGE ON PROCEDURE RUN_AGENT(STRING, STRING) TO ROLE MLOPS_APPROVER;
GRANT USAGE ON PROCEDURE REFRESH_AGENT_EVENTS() TO ROLE MLOPS_UI_RO;
GRANT ROLE MLOPS_UI_RO TO ROLE MLOPS_APPROVER;
GRANT INSERT ON TABLE ACTION_LOG TO ROLE MLOPS_APPROVER;   -- RUN_AGENT is caller's rights
GRANT ROLE MLOPS_APPROVER TO USER ANUDEEP;
