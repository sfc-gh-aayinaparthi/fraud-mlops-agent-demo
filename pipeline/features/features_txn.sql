-- Feature pipeline: transaction features for fraud scoring.
-- Deterministic and replayable: features for transactions in [START_TS, END_TS)
-- depend only on RAW data with txn_ts < END_TS (30-day lookback).
-- Deployed as FEATURES.FN_TXN_FEATURES_<VERSION> by OPS.DEPLOY_FEATURE_PIPELINE.
-- VERSION: v2
CREATE OR REPLACE FUNCTION FRAUD_AUTOML_DEMO.FEATURES.FN_TXN_FEATURES___VERSION__(START_TS TIMESTAMP_NTZ, END_TS TIMESTAMP_NTZ)
RETURNS TABLE (
  txn_id STRING, card_id NUMBER, customer_id NUMBER, merchant_id NUMBER, txn_ts TIMESTAMP_NTZ,
  amount FLOAT, cust_avg_amt_30d FLOAT, amt_to_cust_avg_30d FLOAT,
  txn_count_1h NUMBER, txn_count_24h NUMBER, distance_from_home_km FLOAT,
  merchant_risk_score FLOAT, is_new_merchant NUMBER, hour_of_day NUMBER, is_online NUMBER,
  merchant_category STRING, issuing_platform STRING, card_issued_dt DATE, home_state STRING
)
AS
$$
WITH hist AS (
  SELECT t.*
  FROM FRAUD_AUTOML_DEMO.RAW.TRANSACTIONS t
  WHERE t.txn_ts >= DATEADD(day, -30, START_TS) AND t.txn_ts < END_TS
),
w AS (
  SELECT h.*,
    COUNT(*) OVER (PARTITION BY h.card_id ORDER BY h.txn_ts
        RANGE BETWEEN INTERVAL '1 hour' PRECEDING AND CURRENT ROW) AS txn_count_1h,
    COUNT(*) OVER (PARTITION BY h.card_id ORDER BY h.txn_ts
        RANGE BETWEEN INTERVAL '24 hours' PRECEDING AND CURRENT ROW) AS txn_count_24h,
    IFF(ROW_NUMBER() OVER (PARTITION BY h.customer_id, h.merchant_id ORDER BY h.txn_ts) = 1, 1, 0) AS is_new_merchant
  FROM hist h
)
SELECT w.txn_id, w.card_id, w.customer_id, w.merchant_id, w.txn_ts,
       w.amount::FLOAT AS amount,
       p.avg_amt_30d::FLOAT AS cust_avg_amt_30d,
       (w.amount / COALESCE(p.avg_amt_30d, 1))::FLOAT AS amt_to_cust_avg_30d,
       w.txn_count_1h, w.txn_count_24h,
       HAVERSINE(cu.home_lat, cu.home_lon, m.merch_lat, m.merch_lon)::FLOAT AS distance_from_home_km,
       m.merchant_risk_score::FLOAT AS merchant_risk_score,
       w.is_new_merchant,
       HOUR(w.txn_ts) AS hour_of_day,
       IFF(w.channel = 'ONLINE', 1, 0) AS is_online,
       m.category AS merchant_category, cd.issuing_platform, cd.issued_dt AS card_issued_dt, cu.state AS home_state
FROM w
JOIN FRAUD_AUTOML_DEMO.RAW.CUSTOMERS cu ON cu.customer_id = w.customer_id
JOIN FRAUD_AUTOML_DEMO.RAW.MERCHANTS m ON m.merchant_id = w.merchant_id
JOIN FRAUD_AUTOML_DEMO.RAW.CARDS cd ON cd.card_id = w.card_id
-- perf: use precomputed spend profile from the new customer-profile platform
LEFT JOIN FRAUD_AUTOML_DEMO.RAW.CUSTOMER_PROFILE_V2 p ON p.card_id = w.card_id
WHERE w.txn_ts >= START_TS AND w.txn_ts < END_TS
$$;
