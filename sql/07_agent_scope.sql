-- 07 Agent guardrail: read-only + AI, plus exactly one allow-listed procedure
CREATE RESTRICTED SESSION SCOPE IF NOT EXISTS FRAUD_AUTOML_DEMO.OPS.FRAUD_WATCH_SCOPE
  COMMENT = 'FRAUD_WATCH agent: read-only + AI, plus the one counterfactual procedure'
  AS $$
extend: [SNOWFLAKE$DATA_READ_WITH_AI]
privilege_scopes:
  allowed_privileges:
    - privileges: [usage]
      named_objects:
        - type: procedure
          names: [FRAUD_AUTOML_DEMO.MONITORING.COUNTERFACTUAL_RATE]
$$;
-- Automation (run via Cortex Code):
--   cortex automation create --suspended --name FRAUD_WATCH --prompt-file agent/fraud_watch_prompt.md \
--     --schedule "0 * * * *" --timezone Australia/Sydney \
--     --with-restricted-session-scope FRAUD_AUTOML_DEMO.OPS.FRAUD_WATCH_SCOPE
