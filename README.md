# FRAUD_WATCH: autonomous MLOps agent demo (Snowflake)

A Cortex Code cloud automation watches a production fraud model. It detects anomalies, diagnoses the root cause through lineage and change history, **verifies** the cause with counterfactual re-scoring, opens a revert PR, and emails an incident report. A human approves the merge, in GitHub or in Mission Control.

- `pipeline/features/feature_set.sql`: the versioned feature set (which Feature Store views and versions feed the model; deployed automatically on merge to `main`)
- `agent/fraud_watch_prompt.md`: the agent playbook, including the trace protocol the UI renders
- `sql/01`–`07`, `sql/16`: the fraud system (data, pipeline, serving, monitoring, agent tools, agent scope, Feature Store)
- `sql/08`–`15`: the generic MLOps control plane (`MLOPS_CONTROL.CORE`) and Mission Control grants
- `mission-control/`: the Mission Control app (Snowflake App Runtime, Next.js); see its README for the design brief
- `scripts/`: deploy, training/registration, and demo scenarios
- `demo/RUNBOOK.html`: talk track, steps, and how this works in production

## Feature Store

Model inputs come from the Snowflake Feature Store in `FRAUD_AUTOML_DEMO.FEATURE_STORE` (`sql/16_feature_store.sql`).

| Object | Role |
| --- | --- |
| Entities `CUSTOMER`, `CARD`, `MERCHANT` | Join keys for the feature views |
| `CUSTOMER_SPEND$V1` (managed, dynamic table) | 30-day average spend per customer, as of each transaction; refreshed before every scoring run |
| `CUSTOMER_PROFILE$V1`, `MERCHANT_PROFILE$V1`, `CARD_PROFILE$V1` (views) | Home location, merchant risk/location/category, card platform/issue date |
| `CARD_SPEND_PROFILE$V1` (view) | Spend per card from `RAW.CUSTOMER_PROFILE_V2`; used only by feature set V2 (the planted incident) |
| `OPS.FEATURE_SETS`, `OPS.FEATURE_VIEW_VERSIONS`, `OPS.ACTIVE_FEATURE_SET` | Which view versions make up each set; the live set |
| `OPS.DEPLOY_FEATURE_SET` | CI hook: registers new view versions (immutable once registered) and makes the set live |
| `OPS.ACTIVATE_FEATURE_SET` | Switches back to a registered set (the approved `set_feature_set` action) |
| `FEATURES.FEATURE_SET_SQL` | Builds the model inputs for any set: point-in-time joins of its views plus per-transaction inputs. Serving, training and the agent's what-if tool all use it |

`scripts/feature_store.py` registers sets V1 and V2 without deploying either. `scripts/train_register.py` builds the `FRAUD_TRAINING_SET/V1` dataset from the Feature Store and trains V0/V1, so ML Lineage links each model version to its feature views; `--replace` re-logs them after checking the live flag decisions are unchanged.

## Control plane

System-agnostic: a system is onboarded by inserting configuration rows (`sql/09_seed_fraud.sql`). No code changes. `sql/14_seed_mlops_selfmonitor.sql` registers a second system (the platform monitoring itself); it is not loaded by default, so run it when you want to show a second system on Fleet.

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
2. `python scripts/scenario.py inject`: a "performance" PR is merged and CD deploys feature set V2 (customer spend now from the new profile platform's view).
3. Within about 10 minutes: Fleet shows the open incident; the fraud twin turns red downstream of the feature set.
4. Agents → **Run now** (or wait for the hourly schedule). Open the live run: the violet probe moves across the twin as the agent inspects components; the hypothesis board fills in; counterfactuals confirm feature set V2 and pinpoint the `CARD_SPEND_PROFILE` view.
5. Incident Room → **Approve** the `merge_pr` proposal (requires `ALTER SECRET MLOPS_CONTROL.CORE.GITHUB_PAT SET SECRET_STRING = '<fine-grained PAT>'`; CD deploys set V1), or approve `set_feature_set` to switch back immediately. The incident resolves after 15 quiet minutes.
6. Record a verdict on the agent; Governance shows accuracy, response times and the audit log.
7. Reset: `python scripts/scenario.py reset`.
