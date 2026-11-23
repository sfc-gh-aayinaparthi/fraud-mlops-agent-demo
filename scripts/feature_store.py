"""Feature Store bootstrap: register feature sets V1 and V2 without deploying either.

Registers the entities and every feature view version the sets use, then points
OPS.ACTIVE_FEATURE_SET at whatever version is live today. No change-log entry is
written, so the control plane sees no deploy.

Usage: uv run python scripts/feature_store.py [--connection AZAU_ANUDEEP]
"""
import argparse
import os
import sys

import snowflake.connector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scenario import FILE, v2_source  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--connection", default=os.getenv("SNOWFLAKE_CONNECTION", "AZAU_ANUDEEP"))
    a = p.parse_args()
    v1 = open(FILE).read()
    conn = snowflake.connector.connect(connection_name=a.connection, client_store_temporary_credential=True)
    cur = conn.cursor()
    cur.execute("USE DATABASE FRAUD_AUTOML_DEMO")
    cur.execute("USE WAREHOUSE FRAUD_WH")
    for src in (v1, v2_source(v1)):
        cur.execute("CALL OPS.REGISTER_FEATURE_SET(%s, %s)", (src, "bootstrap"))
        print(cur.fetchone()[0])
    cur.execute("""INSERT INTO OPS.ACTIVE_FEATURE_SET
                   SELECT version, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ FROM OPS.ACTIVE_COMPONENTS
                   WHERE component = 'feature_pipeline'
                     AND NOT EXISTS (SELECT 1 FROM OPS.ACTIVE_FEATURE_SET)""")
    cur.execute("SELECT set_version FROM OPS.ACTIVE_FEATURE_SET")
    print("active feature set:", cur.fetchone()[0])
    conn.close()


if __name__ == "__main__":
    main()
