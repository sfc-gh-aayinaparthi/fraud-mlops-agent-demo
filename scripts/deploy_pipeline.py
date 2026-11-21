"""Deploy the feature pipeline at the current Git commit (used by CI on merge to main).

Usage: uv run python scripts/deploy_pipeline.py <version> [--connection AZAU_ANUDEEP]
"""
import argparse
import os
import subprocess

import snowflake.connector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIPELINE_FILE = os.path.join(ROOT, "pipeline", "features", "features_txn.sql")


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("version")
    p.add_argument("--connection", default=os.getenv("SNOWFLAKE_CONNECTION", "AZAU_ANUDEEP"))
    a = p.parse_args()

    with open(PIPELINE_FILE) as f:
        source_sql = f.read()
    try:
        sha = git("rev-parse", "--short", "HEAD")
        author = git("log", "-1", "--format=%an")
        message = git("log", "-1", "--format=%s")
    except subprocess.CalledProcessError:
        sha, author, message = "uncommitted", os.getenv("USER", "unknown"), "manual deploy"

    conn = snowflake.connector.connect(connection_name=a.connection, client_store_temporary_credential=True)
    cur = conn.cursor()
    cur.execute("USE DATABASE FRAUD_AUTOML_DEMO")
    cur.execute("USE WAREHOUSE FRAUD_WH")
    cur.execute(
        "CALL FRAUD_AUTOML_DEMO.OPS.DEPLOY_FEATURE_PIPELINE(%s, %s, %s, %s, %s)",
        (a.version, sha, author, message, source_sql),
    )
    print(cur.fetchone()[0])
    conn.close()


if __name__ == "__main__":
    main()
