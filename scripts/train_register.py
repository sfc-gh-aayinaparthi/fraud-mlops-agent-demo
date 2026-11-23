"""Train fraud models from the Feature Store and log them to the Model Registry.

V0: baseline (no velocity / distance features).  V1: full feature set (default version).
Training data is a versioned Dataset generated from feature set V1, so ML Lineage links
each model version to the feature view versions it was trained on.

  uv run python scripts/train_register.py            # build dataset, train, compare with the live models
  uv run python scripts/train_register.py --replace  # ...then replace V0/V1 in the registry

Replacing is only allowed when the new models score the last day of served features the
same way as the live ones (flag agreement >= 99.9%), so the swap does not move the flag rate.
"""
import argparse
import json
import os

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score
from snowflake.ml.feature_store import FeatureStore
from snowflake.ml.registry import Registry
from snowflake.snowpark import Session
from xgboost import XGBClassifier

DB, SCHEMA = "FRAUD_AUTOML_DEMO", "ML"
SET_VERSION, DATASET = "V1", "FRAUD_TRAINING_SET"
TRAIN_START, TRAIN_END, TEST_START = "2026-09-25 00:00:00", "2026-11-15 00:00:00", "2026-11-05"
FEATURES_V1 = [
    "AMOUNT", "AMT_TO_CUST_AVG_30D", "TXN_COUNT_1H", "TXN_COUNT_24H",
    "DISTANCE_FROM_HOME_KM", "MERCHANT_RISK_SCORE", "IS_NEW_MERCHANT", "HOUR_OF_DAY", "IS_ONLINE",
]
FEATURES_V0 = ["AMOUNT", "AMT_TO_CUST_AVG_30D", "MERCHANT_RISK_SCORE", "HOUR_OF_DAY", "IS_ONLINE"]
SPECS = [
    ("V0", FEATURES_V0, dict(n_estimators=150, max_depth=3, learning_rate=0.1)),
    ("V1", FEATURES_V1, dict(n_estimators=300, max_depth=5, learning_rate=0.08)),
]


def build_dataset(session, fs):
    """Spine = transaction-level inputs + label; entity features joined point-in-time by the Feature Store."""
    spine_sql = session.sql("CALL FEATURES.FEATURE_SET_SQL(?, ?, ?, PARSE_JSON('{\"spine_only\": true}'))",
                            params=[SET_VERSION, TRAIN_START, TRAIN_END]).collect()[0][0]
    spine = session.sql(f"SELECT s.*, g.is_fraud FROM ({spine_sql}) s "
                        f"JOIN {DB}.RAW.FRAUD_GROUND_TRUTH g ON g.txn_id = s.txn_id")
    views = [fs.get_feature_view(r[0], r[1]) for r in session.sql(
        "SELECT view_name, view_version FROM OPS.FEATURE_SETS WHERE set_version = ? ORDER BY 1",
        params=[SET_VERSION]).collect()]
    try:
        ds = fs.generate_dataset(DATASET, spine, views, version=SET_VERSION, spine_timestamp_col="TXN_TS",
                                 spine_label_cols=["IS_FRAUD"],
                                 desc=f"Fraud training data from feature set {SET_VERSION}, {TRAIN_START}..{TRAIN_END}")
    except Exception as ex:
        if "already exists" not in str(ex):
            raise
        from snowflake.ml.dataset import load_dataset
        ds = load_dataset(session, f"{DB}.FEATURE_STORE.{DATASET}", SET_VERSION)
    # the two inputs that combine views, computed exactly as FEATURES.FEATURE_SET_SQL does at serving time
    return ds, ds.read.to_snowpark_dataframe().select_expr(
        "*", "(AMOUNT / COALESCE(CUST_AVG_AMT_30D, 1))::FLOAT AS AMT_TO_CUST_AVG_30D",
        "HAVERSINE(HOME_LAT, HOME_LON, MERCH_LAT, MERCH_LON)::FLOAT AS DISTANCE_FROM_HOME_KM")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--replace", action="store_true")
    a = p.parse_args()
    session = Session.builder.config("connection_name", os.getenv("SNOWFLAKE_CONNECTION", "AZAU_ANUDEEP")).create()
    session.use_warehouse("FRAUD_TRAIN_WH")
    session.use_database(DB)
    session.use_schema(SCHEMA)
    fs = FeatureStore(session, DB, "FEATURE_STORE", "FRAUD_TRAIN_WH")

    ds, train_sdf = build_dataset(session, fs)
    df = train_sdf.to_pandas()
    old = session.table("TRAINING_SET_V1").to_pandas()
    print(f"dataset {DATASET}/{SET_VERSION}: {len(df):,} rows (old TRAINING_SET_V1: {len(old):,})")
    df["TXN_TS"] = pd.to_datetime(df["TXN_TS"])
    df = df.sort_values(["TXN_TS", "TXN_ID", "CARD_ID"]).reset_index(drop=True)
    train, test = df[df["TXN_TS"] < TEST_START], df[df["TXN_TS"] >= TEST_START]

    # live scoring sample: the last day of served features
    live = session.sql("SELECT * FROM SERVING.FEATURE_LOG WHERE txn_ts >= DATEADD(day, -1, CURRENT_TIMESTAMP())"
                       ).to_pandas()
    reg = Registry(session=session, database_name=DB, schema_name=SCHEMA)
    m = reg.get_model("FRAUD_XGB")

    models, agree = {}, {}
    for version, feats, params in SPECS:
        model = XGBClassifier(**params, eval_metric="aucpr", n_jobs=-1, random_state=0)
        model.fit(train[feats].astype(float), train["IS_FRAUD"])
        pr = model.predict_proba(test[feats].astype(float))[:, 1]
        metrics = {
            "auc": float(roc_auc_score(test["IS_FRAUD"], pr)),
            "avg_precision": float(average_precision_score(test["IS_FRAUD"], pr)),
            "flag_rate_at_0_5": float((pr >= 0.5).mean()),
            "train_window": f"{TRAIN_START[:10]}..{TEST_START}",
            "feature_pipeline_version": SET_VERSION,
            "training_dataset": f"{DATASET}/{SET_VERSION}",
        }
        new_flag = model.predict_proba(live[feats].astype(float))[:, 1] >= 0.5
        cur = m.version(version).run(live[feats].astype(float), function_name="PREDICT_PROBA")
        col = next(c for c in cur.columns if c.lower() == "output_feature_1") if any(
            c.lower() == "output_feature_1" for c in cur.columns) else None
        probs = cur[col] if col else pd.json_normalize(
            cur.iloc[:, -1].apply(lambda x: json.loads(x) if isinstance(x, str) else x))["output_feature_1"]
        cur_flag = probs.astype(float).to_numpy() >= 0.5
        agree[version] = float(np.mean(new_flag == cur_flag))
        print(version, {k: round(v, 4) if isinstance(v, float) else v for k, v in metrics.items()},
              f"live flag rate old={cur_flag.mean():.4f} new={new_flag.mean():.4f} agreement={agree[version]:.4%}")
        models[version] = (model, feats, metrics)

    if not a.replace:
        print("compare only; rerun with --replace to swap the registry versions")
        return
    if min(agree.values()) < 0.999:
        raise SystemExit(f"not replacing: flag agreement {agree} is below 99.9%")

    sample = train_sdf.select(FEATURES_V1).limit(100)
    monitor = session.sql("SHOW MODEL MONITORS LIKE 'FRAUD_XGB_V1_MONITOR' IN SCHEMA ML").collect()
    session.sql(f"ALTER TASK {DB}.OPS.TASK_PIPELINE_TICK SUSPEND").collect()
    try:
        if monitor:
            session.sql("DROP MODEL MONITOR ML.FRAUD_XGB_V1_MONITOR").collect()
        for version, (model, feats, metrics) in models.items():
            other = "V1" if version == "V0" else "V0"
            m.default = other
            m.delete_version(version)
            reg.log_model(model, model_name="FRAUD_XGB", version_name=version,
                          sample_input_data=sample.select(feats), target_platforms=["WAREHOUSE"], metrics=metrics,
                          comment=f"Fraud XGBoost {version}; features={','.join(feats)}; "
                                  f"trained on {DATASET}/{SET_VERSION} (feature set {SET_VERSION})",
                          options={"relax_version": True})
            print(f"re-logged {version} from {DATASET}/{SET_VERSION}")
        m.default = "V1"
    finally:
        session.sql(f"ALTER TASK {DB}.OPS.TASK_PIPELINE_TICK RESUME").collect()
    if monitor:
        print("model monitor dropped: recreate it with the CREATE MODEL MONITOR block in sql/05_monitoring.sql")
    session.close()


if __name__ == "__main__":
    main()
