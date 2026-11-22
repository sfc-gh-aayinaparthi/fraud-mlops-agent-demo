# FRAUD_WATCH: autonomous MLOps agent demo (Snowflake)

A Cortex Code cloud automation watches a production fraud model. It detects anomalies, diagnoses the root cause through lineage and change history, **verifies** the cause with counterfactual re-scoring, opens a revert PR, and emails an incident report. A human approves the merge, in GitHub or in Mission Control.

- `pipeline/features/features_txn.sql`: the versioned feature pipeline (deployed automatically on merge to `main`)
- `agent/fraud_watch_prompt.md`: the agent playbook, including the trace protocol the UI renders
- `sql/01`–`07`: the fraud system (data, pipeline, serving, monitoring, agent tools, agent scope)
- `sql/08`–`15`: the generic MLOps control plane (`MLOPS_CONTROL.CORE`) and Mission Control grants
- `mission-control/`: the Mission Control app (Snowflake App Runtime, Next.js); see its README for the design brief
- `scripts/`: deploy, training/registration, and demo scenarios
- `demo/RUNBOOK.html`: talk track, steps, and how this works in production

## Control plane

System-agnostic: a system is onboarded by inserting configuration rows (`sql/09_seed_fraud.sql`, `sql/14_seed_mlops_selfmonitor.sql`). No code changes.

| Object | Role |
| --- | --- |
| `SYSTEMS`, `ENTITIES`, `EDGES` | Registry and topology (drives the 3D twin) |
| `METRIC_CATALOG` → `SIGNALS` | Metrics as SQL with expected ranges (same-hour baseline or static); evaluated every 5 min |
| `CHANGE_SOURCES` → `CHANGES` | Unified change feed (deploys, DDL, …) |
| `INCIDENTS`, `INCIDENT_SIGNALS` | Abnormal signals correlated per system; auto-resolve when quiet |
| `SLICE_CONFIG`, `SLICE_EXCESS` | Which dimension concentrates an outcome shift |
| `AGENTS`, `AGENT_EVENTS` | Agent span traces (JSONL in the agent's workspace, loaded every minute) |
| `ACTION_TYPES`, `V_PROPOSALS`, `EXECUTE_ACTION`, `ACTION_LOG` | Typed actions, approval policy (MLOPS_APPROVER), executors, audit |
| `COMPONENT_DEPLOY`, `DEPLOY_FROM_GIT` | Git → Snowflake continuous deploy per component |

Tasks: `TASK_CONTROL_PLANE` (5 min), `TASK_CONTINUOUS_DEPLOY` (1 min), `TASK_LOAD_AGENT_EVENTS` (1 min, runs as the agent owner). All use `FRAUD_WH`, which keeps the warehouse awake while they are resumed; suspend them between demos.

## Mission Control demo flow

1. Open the app (`snow app open` in `mission-control/`); Fleet should read "All monitored systems are within their expected ranges".
2. `python scripts/scenario.py inject`: a "performance" PR is merged and CD deploys pipeline V2.
3. Within about 10 minutes: Fleet shows the open incident; the fraud twin turns red downstream of the feature pipeline.
4. Agents → **Run now** (or wait for the hourly schedule). Open the live run: the violet probe moves across the twin as the agent inspects components; the hypothesis board fills in; counterfactuals confirm pipeline V2.
5. Incident Room → **Approve** the `merge_pr` proposal. Requires `ALTER SECRET MLOPS_CONTROL.CORE.GITHUB_PAT SET SECRET_STRING = '<fine-grained PAT>'`. CD deploys V1; the incident resolves after 15 quiet minutes.
6. Record a verdict on the agent; Governance shows accuracy, response times and the audit log.
7. Reset: `python scripts/scenario.py reset`.
