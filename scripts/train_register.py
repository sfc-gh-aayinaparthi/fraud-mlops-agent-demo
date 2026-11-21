"""Train fraud models and log them to the Snowflake Model Registry.

V0: baseline (no velocity / distance features).  V1: full feature set (default version).
Usage: uv run python scripts/train_register.py
"""
import os

import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score
from snowflake.ml.registry import Registry
from snowflake.snowpark import Session
from xgboost import XGBClassifier

DB, SCHEMA = "FRAUD_AUTOML_DEMO", "ML"
FEATURES_V1 = [
    "AMOUNT", "AMT_TO_CUST_AVG_30D", "TXN_COUNT_1H", "TXN_COUNT_24H",
    "DISTANCE_FROM_HOME_KM", "MERCHANT_RISK_SCORE", "IS_NEW_MERCHANT", "HOUR_OF_DAY", "IS_ONLINE",
]
FEATURES_V0 = ["AMOUNT", "AMT_TO_CUST_AVG_30D", "MERCHANT_RISK_SCORE", "HOUR_OF_DAY", "IS_ONLINE"]

session = Session.builder.config("connection_name", os.getenv("SNOWFLAKE_CONNECTION", "AZAU_ANUDEEP")).create()
session.use_warehouse("FRAUD_TRAIN_WH")
session.use_database(DB)
session.use_schema(SCHEMA)

df = session.table("TRAINING_SET_V1").to_pandas()
df["TXN_TS"] = pd.to_datetime(df["TXN_TS"])
train = df[df["TXN_TS"] < "2026-11-05"]
test = df[df["TXN_TS"] >= "2026-11-05"]
print(f"train={len(train):,} test={len(test):,} fraud_rate={df.IS_FRAUD.mean():.4f}")

reg = Registry(session=session, database_name=DB, schema_name=SCHEMA)
results = {}
for version, feats, params in [
    ("V0", FEATURES_V0, dict(n_estimators=150, max_depth=3, learning_rate=0.1)),
    ("V1", FEATURES_V1, dict(n_estimators=300, max_depth=5, learning_rate=0.08)),
]:
    model = XGBClassifier(**params, eval_metric="aucpr", n_jobs=-1)
    model.fit(train[feats].astype(float), train["IS_FRAUD"])
    p = model.predict_proba(test[feats].astype(float))[:, 1]
    flag_rate = float((p >= 0.5).mean())
    metrics = {
        "auc": float(roc_auc_score(test["IS_FRAUD"], p)),
        "avg_precision": float(average_precision_score(test["IS_FRAUD"], p)),
        "flag_rate_at_0_5": flag_rate,
        "train_window": "2026-09-25..2026-11-05",
        "feature_pipeline_version": "V1",
    }
    print(version, metrics)
    try:
        reg.get_model("FRAUD_XGB").version(version)
        print(f"{version} already registered, skipping")
        continue
    except Exception:
        pass
    reg.log_model(
        model,
        model_name="FRAUD_XGB",
        version_name=version,
        sample_input_data=train[feats].astype(float).head(100),
        target_platforms=["WAREHOUSE"],
        metrics=metrics,
        comment=f"Fraud XGBoost {version}; features={','.join(feats)}",
        options={"relax_version": True},
    )
    results[version] = metrics

m = reg.get_model("FRAUD_XGB")
m.default = "V1"
print("default version:", m.default.version_name)
session.close()
