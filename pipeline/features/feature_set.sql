-- Fraud model feature set: which Feature Store views (and versions) feed the model.
-- Deployed by OPS.DEPLOY_FEATURE_SET (CI, on merge to main): registers any feature view
-- version below that is not yet in FRAUD_AUTOML_DEMO.FEATURE_STORE, then makes this set live.
-- Feature view versions are immutable: to change a definition, add it under a new version.
-- Transaction-level inputs (amount, card velocity, new-merchant flag, hour, channel, and the
-- amount-vs-usual-spend ratio and distance-from-home that combine views) are computed at
-- scoring time by FEATURES.FEATURE_SET_SQL.
-- VERSION: v1
-- USES: CUSTOMER_SPEND/V1, CUSTOMER_PROFILE/V1, MERCHANT_PROFILE/V1, CARD_PROFILE/V1

-- @feature_view CUSTOMER_SPEND/V1 entity=CUSTOMER timestamp=SPEND_TS
-- desc: Customer's average spend over the previous 30 days, as of each of their transactions
SELECT customer_id, txn_ts AS spend_ts,
       AVG(amount) OVER (PARTITION BY customer_id ORDER BY txn_ts
           RANGE BETWEEN INTERVAL '30 days' PRECEDING AND CURRENT ROW)::FLOAT AS cust_avg_amt_30d
FROM FRAUD_AUTOML_DEMO.RAW.TRANSACTIONS;

-- @feature_view CUSTOMER_PROFILE/V1 entity=CUSTOMER
-- desc: Customer home location and state
SELECT customer_id, home_lat, home_lon, state AS home_state
FROM FRAUD_AUTOML_DEMO.RAW.CUSTOMERS;

-- @feature_view MERCHANT_PROFILE/V1 entity=MERCHANT
-- desc: Merchant risk score, location and category
SELECT merchant_id, merchant_risk_score::FLOAT AS merchant_risk_score, merch_lat, merch_lon,
       category AS merchant_category
FROM FRAUD_AUTOML_DEMO.RAW.MERCHANTS;

-- @feature_view CARD_PROFILE/V1 entity=CARD
-- desc: Card issuing platform and issue date
SELECT card_id, issuing_platform, issued_dt AS card_issued_dt
FROM FRAUD_AUTOML_DEMO.RAW.CARDS;
