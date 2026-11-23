"""Demo scenario controls.

  uv run python scripts/scenario.py inject      # merge the 'profile v2' refactor via a real PR and deploy it (the planted incident)
  uv run python scripts/scenario.py deploy-main # CI step: deploy whatever is on main (run after a human merges the revert PR)
  uv run python scripts/scenario.py burst-on    # genuine fraud attack (gift cards), no code change
  uv run python scripts/scenario.py burst-off
  uv run python scripts/scenario.py reset       # back to v1, drop incident-window data
"""
import os
import re
import subprocess
import sys

import snowflake.connector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "sfc-gh-aayinaparthi/fraud-mlops-agent-demo"
FILE = os.path.join(ROOT, "pipeline", "features", "feature_set.sql")
CONN = os.getenv("SNOWFLAKE_CONNECTION", "AZAU_ANUDEEP")
AUTHOR = ["-c", "user.name=Daniel Wu", "-c", "user.email=daniel.wu@example.com", "-c", "commit.gpgsign=false"]


def sh(*cmd, check=True):
    print("$", " ".join(cmd))
    return subprocess.run(cmd, cwd=ROOT, check=check, text=True, capture_output=True).stdout.strip()


def sql(*stmts):
    conn = snowflake.connector.connect(connection_name=CONN, client_store_temporary_credential=True)
    cur = conn.cursor()
    cur.execute("USE DATABASE FRAUD_AUTOML_DEMO")
    cur.execute("USE WAREHOUSE FRAUD_WH")
    out = None
    for s in stmts:
        cur.execute(s)
        out = cur.fetchall()
    conn.close()
    return out


def deployed_version_on_main():
    m = re.search(r"-- VERSION: (\w+)", open(FILE).read())
    return m.group(1)


def deploy_main():
    """CD: deploy whatever is on main, via the generic control-plane hook."""
    sh("git", "checkout", "main")
    sh("git", "pull", "--ff-only")
    print(sql("CALL MLOPS_CONTROL.CORE.DEPLOY_FROM_GIT('fraud.feat.txn_features', FALSE)")[0][0])


def v2_source(src: str) -> str:
    """The planted change: take 30-day spend from the new profile platform's card-level view."""
    src = src.replace("-- VERSION: v1", "-- VERSION: v2")
    src = src.replace("-- USES: CUSTOMER_SPEND/V1,", "-- USES: CARD_SPEND_PROFILE/V1,")
    src = src.rstrip("\n") + (
        "\n\n-- @feature_view CARD_SPEND_PROFILE/V1 entity=CARD\n"
        "-- desc: Precomputed 30-day spend per card from the new customer-profile platform\n"
        "-- perf: replaces the 30-day window scan over transactions\n"
        "SELECT card_id, avg_amt_30d::FLOAT AS cust_avg_amt_30d\n"
        "FROM FRAUD_AUTOML_DEMO.RAW.CUSTOMER_PROFILE_V2;\n")
    assert "-- USES: CARD_SPEND_PROFILE/V1," in src
    return src


def mark(name):
    sql("CREATE TABLE IF NOT EXISTS OPS.SCENARIO_LOG (scenario STRING, started_at TIMESTAMP_NTZ)",
        f"INSERT INTO OPS.SCENARIO_LOG VALUES ('{name}', CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)")


def inject():
    mark("pipeline_incident")
    sh("git", "checkout", "main")
    sh("git", "pull", "--ff-only")
    branch = "feature/customer-profile-v2"
    sh("git", "checkout", "-B", branch)
    with open(FILE) as f:
        new_src = v2_source(f.read())
    with open(FILE, "w") as f:
        f.write(new_src)
    # commit only the pipeline file, so unrelated local edits never ride along (or get reverted)
    sh("git", *AUTHOR, "commit", FILE, "-m",
       "perf(features): take 30d spend from the customer-profile v2 feature view instead of window scan")
    sh("git", "push", "-f", "-u", "origin", branch)
    url = sh("gh", "pr", "create", "--repo", REPO, "--base", "main", "--head", branch,
             "--title", "perf(features): use customer profile v2 for 30d spend",
             "--body", "Feature set v2: swaps the CUSTOMER_SPEND feature view (30-day window scan) for the new "
                       "CARD_SPEND_PROFILE view on the customer-profile platform. ~4x faster refresh. "
                       "Tested on a sample of legacy cards.")
    print(url)
    sh("gh", "pr", "merge", url, "--squash", "--admin", "--delete-branch")
    deploy_main()


def burst(on: bool):
    if on:
        mark("fraud_burst")
    sql("DELETE FROM OPS.ACTIVE_FRAUD_BURST",
        "INSERT INTO OPS.ACTIVE_FRAUD_BURST VALUES ('GIFT_CARDS', 0.09, TRUE)" if on else "SELECT 1")
    print("fraud burst", "ON (9% of txns, gift cards)" if on else "OFF")


def reset():
    burst(False)
    sh("git", "checkout", "main")
    sh("git", "pull", "--ff-only")
    if deployed_version_on_main() != "v1":
        raise SystemExit("main is not on v1 - merge the revert PR (or revert manually) first")
    v = sql("SELECT MAX(set_version) FROM OPS.ACTIVE_FEATURE_SET")[0][0]
    if v != "V1":
        deploy_main()
    # remove everything generated since the first scenario started, so baselines stay clean
    since = "(SELECT MIN(started_at) FROM OPS.SCENARIO_LOG)"
    sql("CREATE TABLE IF NOT EXISTS OPS.SCENARIO_LOG (scenario STRING, started_at TIMESTAMP_NTZ)",
        f"DELETE FROM SERVING.PREDICTIONS WHERE txn_ts >= {since}",
        f"DELETE FROM SERVING.FEATURE_LOG WHERE txn_ts >= {since}",
        f"DELETE FROM RAW.FRAUD_LABELS WHERE txn_id IN (SELECT txn_id FROM RAW.TRANSACTIONS WHERE txn_ts >= {since})",
        f"DELETE FROM RAW.FRAUD_GROUND_TRUTH WHERE txn_id IN (SELECT txn_id FROM RAW.TRANSACTIONS WHERE txn_ts >= {since})",
        f"DELETE FROM RAW.TRANSACTIONS WHERE txn_ts >= {since}",
        "DELETE FROM OPS.PIPELINE_STATE",
        "TRUNCATE TABLE OPS.SCENARIO_LOG")
    print("reset complete")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    {"inject": inject, "deploy-main": deploy_main, "burst-on": lambda: burst(True),
     "burst-off": lambda: burst(False), "reset": reset}.get(cmd, lambda: print(__doc__))()
