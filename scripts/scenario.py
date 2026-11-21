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
FILE = os.path.join(ROOT, "pipeline", "features", "features_txn.sql")
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
    sh("git", "checkout", "main")
    sh("git", "pull", "--ff-only")
    v = deployed_version_on_main()
    print(subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "deploy_pipeline.py"), v],
                         cwd=ROOT, check=True, text=True, capture_output=True).stdout)


def v2_source(src: str) -> str:
    src = src.replace("-- VERSION: v1", "-- VERSION: v2")
    src = src.replace(
        """    AVG(h.amount) OVER (PARTITION BY h.customer_id ORDER BY h.txn_ts
        RANGE BETWEEN INTERVAL '30 days' PRECEDING AND CURRENT ROW) AS cust_avg_amt_30d,
""", "")
    src = src.replace(
        "       w.cust_avg_amt_30d::FLOAT AS cust_avg_amt_30d,\n       (w.amount / COALESCE(w.cust_avg_amt_30d, 1))::FLOAT AS amt_to_cust_avg_30d,",
        "       p.avg_amt_30d::FLOAT AS cust_avg_amt_30d,\n       (w.amount / COALESCE(p.avg_amt_30d, 1))::FLOAT AS amt_to_cust_avg_30d,")
    src = src.replace(
        "JOIN FRAUD_AUTOML_DEMO.RAW.CARDS cd ON cd.card_id = w.card_id\n",
        "JOIN FRAUD_AUTOML_DEMO.RAW.CARDS cd ON cd.card_id = w.card_id\n"
        "-- perf: use precomputed spend profile from the new customer-profile platform\n"
        "LEFT JOIN FRAUD_AUTOML_DEMO.RAW.CUSTOMER_PROFILE_V2 p ON p.card_id = w.card_id\n")
    assert "CUSTOMER_PROFILE_V2" in src and "RANGE BETWEEN INTERVAL '30 days'" not in src
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
    open(FILE, "w").write(v2_source(open(FILE).read()))
    sh("git", *AUTHOR, "commit", "-am",
       "perf(features): source 30d customer spend from CUSTOMER_PROFILE_V2 instead of window scan")
    sh("git", "push", "-f", "-u", "origin", branch)
    url = sh("gh", "pr", "create", "--repo", REPO, "--base", "main", "--head", branch,
             "--title", "perf(features): use customer profile v2 for 30d spend",
             "--body", "Replaces the 30-day window scan with the precomputed spend profile from the new "
                       "customer-profile platform. ~4x faster feature build. Tested on a sample of legacy cards.")
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
    v = sql("SELECT MAX(version) FROM OPS.ACTIVE_COMPONENTS WHERE component='feature_pipeline'")[0][0]
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
