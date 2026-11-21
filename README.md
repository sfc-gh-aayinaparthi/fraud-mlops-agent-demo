# FRAUD_WATCH: autonomous MLOps agent demo (Snowflake)

A Cortex Code cloud automation watches a production fraud model. It detects anomalies, diagnoses the root cause through lineage and change history, **verifies** the cause with counterfactual re-scoring, opens a revert PR, and emails an incident report. A human merges.

- `pipeline/features/features_txn.sql`: the versioned feature pipeline (deployed by CI on merge to `main`)
- `agent/fraud_watch_prompt.md`: the agent playbook
- `sql/`: Snowflake setup (`01`-`06`)
- `scripts/`: deploy, training/registration, and demo scenarios
- `demo/RUNBOOK.html`: talk track, steps, and how this works in production
