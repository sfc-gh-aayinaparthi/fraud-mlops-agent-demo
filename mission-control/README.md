# Mission Control

Agentic MLOps control room on Snowflake App Runtime. It shows live health for every registered ML system as a 3D digital twin, correlates abnormal signals into incidents, records every autonomous agent run as a replayable trace, and lets approvers execute the agents' proposed fixes under policy.

The app is generic. It reads only the control plane in `MLOPS_CONTROL.CORE` (`../sql/08`–`13`); a system is onboarded by inserting configuration rows (`../sql/09_seed_fraud.sql`, `../sql/14_seed_mlops_selfmonitor.sql`), with no code changes.

## Design brief

- **Who and when:** an ML Ops / platform engineer on shift, or paged, checking whether production models are healthy and what the agent is doing about any that are not.
- **The one question:** is anything abnormal right now, is it explained, and is someone (human or agent) handling it?
- **Focal element:** a plain-language headline ("1 open incident across 1 system") over the system tiles; on a system, the 3D twin dominates, with health on every station and the agent's violet probe hovering over whatever it is inspecting.
- **Direction:** night control tower: near-black blue room (`#0a0f14`), phosphor teal for healthy flow, amber and coral only for state, violet reserved for the agent. Space Grotesk display over IBM Plex Sans, IBM Plex Mono for SQL. Dark by default with a cool paper light mode. Not doing: a white stat-card dashboard, glassmorphism, or decorative glow.
- **Signature detail:** particles stream through the twin's pipes at the system's live volume and carry the worst status they have passed through, so a sick component visibly contaminates everything downstream; flagged decisions appear as larger coral particles.
- **Next step:** open the incident (heatmap, change feed, slices, the agent's hypotheses and counterfactuals), then approve or reject the agent's proposed action, or start an agent run; record a verdict on the agent so Governance tracks its accuracy.
- **Trust:** every number comes from `MLOPS_CONTROL.CORE.SIGNALS`, evaluated every 5 minutes by `TASK_CONTROL_PLANE`; the header shows how long ago. Timestamps are account wall-clock time (Australia/Sydney). Expected ranges come from the metric catalog (same-hour 7-day baseline or static limits). Actions run with the viewer's own Snowflake identity (caller's rights) and are written to `ACTION_LOG`.

## Screens

| Route | Purpose |
| --- | --- |
| `/` | Fleet: headline, system tiles, metrics abnormal now (unexplained first), latest agent runs |
| `/systems/[id]` | 3D twin generated from `ENTITIES`/`EDGES`, golden-signal strip, node drawer with signal history, live agent probe |
| `/incidents`, `/incidents/[id]` | Incident Room: timeline with change markers, change feed, signal heatmap, slice concentration, agent hypotheses and experiments, proposals, Explore (read-only SQL as the viewer) |
| `/agents`, `/agents/runs/[runId]` | Agents and the flight recorder: live and replayable traces with scrubber, probe on the twin, hypothesis board as of any point |
| `/governance` | Agent accuracy from engineer verdicts, response times, action policy, coverage gaps, audit log |

## Access model

- Reads run with the app's owner role and need `MLOPS_UI_RO`-equivalent grants (SELECT on `MLOPS_CONTROL.CORE` and the systems' data used by metric SQL, USAGE on `SLICE_EXCESS` and `REFRESH_AGENT_EVENTS`).
- Writes (run agent, approve/reject, verdict) and Explore run with caller's rights. `EXECUTE_ACTION`, `RUN_AGENT` and `SET_HUMAN_VERDICT` are granted only to `MLOPS_APPROVER`, so Snowflake privileges enforce the approval policy.

## Develop

```bash
npm ci
SNOWFLAKE_DEFAULT_CONNECTION_NAME=<connection> npm run dev
npm run build
```

`TEMPLATE_GUIDE.md` is the original SAR Next.js template guide.
