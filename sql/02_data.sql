-- 02 Synthetic AU card data + reusable transaction generator
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE FRAUD_TRAIN_WH;
USE DATABASE FRAUD_AUTOML_DEMO;

-- Reference: 8 AU cities (state index 0-7)
CREATE OR REPLACE TABLE RAW.REF_CITIES AS
SELECT * FROM VALUES
 (0,'NSW','Sydney',-33.8688,151.2093),(1,'VIC','Melbourne',-37.8136,144.9631),
 (2,'QLD','Brisbane',-27.4698,153.0251),(3,'WA','Perth',-31.9505,115.8605),
 (4,'SA','Adelaide',-34.9285,138.6007),(5,'TAS','Hobart',-42.8821,147.3272),
 (6,'ACT','Canberra',-35.2809,149.1300),(7,'NT','Darwin',-12.4634,130.8456)
 AS t(state_idx,state,city,lat,lon);

CREATE OR REPLACE TABLE RAW.CUSTOMERS AS
SELECT SEQ4()+1 AS customer_id,
       c.state_idx, c.state, c.city,
       c.lat + NORMAL(0,0.15,RANDOM()) AS home_lat,
       c.lon + NORMAL(0,0.15,RANDOM()) AS home_lon,
       ROUND(EXP(NORMAL(3.9,0.6,RANDOM())),2) AS base_spend,     -- typical txn ~ $50
       UNIFORM(18,85,RANDOM()) AS age,
       DATEADD(day,-UNIFORM(200,4000,RANDOM()),'2026-11-21'::DATE) AS customer_since
FROM TABLE(GENERATOR(ROWCOUNT=>50000)) g
JOIN RAW.REF_CITIES c ON c.state_idx = MOD(ABS(HASH(SEQ4())),8);

-- Legacy cards (1 per customer) + 20K new cards issued from Oct 2026
CREATE OR REPLACE TABLE RAW.CARDS AS
SELECT customer_id AS card_id, customer_id,
       DATEADD(day,-UNIFORM(60,1500,RANDOM()),'2026-10-01'::DATE) AS issued_dt,
       'LEGACY_PLATFORM' AS issuing_platform
FROM RAW.CUSTOMERS
UNION ALL
SELECT 50000+SEQ4()+1, UNIFORM(1,50000,RANDOM()),
       DATEADD(day,UNIFORM(0,44,RANDOM()),'2026-10-01'::DATE),
       'NEW_CARD_PLATFORM'
FROM TABLE(GENERATOR(ROWCOUNT=>20000));

CREATE OR REPLACE TABLE RAW.MERCHANTS AS
WITH m AS (
  SELECT SEQ4() AS merchant_id, MOD(SEQ4(),8) AS state_idx,
         UNIFORM(1,100,RANDOM()) AS r
  FROM TABLE(GENERATOR(ROWCOUNT=>5000)))
SELECT m.merchant_id, c.state, c.city,
       c.lat + NORMAL(0,0.2,RANDOM()) AS merch_lat,
       c.lon + NORMAL(0,0.2,RANDOM()) AS merch_lon,
       CASE WHEN r<=20 THEN 'GROCERY' WHEN r<=38 THEN 'RESTAURANT' WHEN r<=50 THEN 'FUEL'
            WHEN r<=62 THEN 'RETAIL' WHEN r<=72 THEN 'TRAVEL' WHEN r<=82 THEN 'ONLINE_MARKETPLACE'
            WHEN r<=90 THEN 'ELECTRONICS' WHEN r<=96 THEN 'GIFT_CARDS' ELSE 'CRYPTO_EXCHANGE' END AS category,
       CASE WHEN r>90 THEN UNIFORM(60,95,RANDOM()) WHEN r>82 THEN UNIFORM(30,60,RANDOM())
            ELSE UNIFORM(1,30,RANDOM()) END / 100.0 AS merchant_risk_score
FROM m JOIN RAW.REF_CITIES c USING (state_idx);

CREATE TABLE IF NOT EXISTS RAW.TRANSACTIONS (
  txn_id STRING, card_id NUMBER, customer_id NUMBER, merchant_id NUMBER,
  txn_ts TIMESTAMP_NTZ, amount NUMBER(12,2), channel STRING, loaded_at TIMESTAMP_NTZ
) CHANGE_TRACKING = TRUE;

-- Simulator-only ground truth; labels surface into RAW.FRAUD_LABELS once labelled_at passes
-- (chargebacks / investigations arrive days later)
CREATE TABLE IF NOT EXISTS RAW.FRAUD_GROUND_TRUTH (
  txn_id STRING, is_fraud BOOLEAN, labelled_at TIMESTAMP_NTZ
);
CREATE TABLE IF NOT EXISTS RAW.FRAUD_LABELS (
  txn_id STRING, is_fraud BOOLEAN, labelled_at TIMESTAMP_NTZ
) CHANGE_TRACKING = TRUE;

-- Generator: n transactions uniformly in [start_ts, end_ts).
-- burst_category: if set, injects a genuine fraud attack concentrated in that category.
CREATE OR REPLACE PROCEDURE OPS.GENERATE_TRANSACTIONS(
    START_TS TIMESTAMP_NTZ, END_TS TIMESTAMP_NTZ, N NUMBER,
    FRAUD_RATE FLOAT DEFAULT 0.02, BURST_CATEGORY STRING DEFAULT NULL, BURST_RATE FLOAT DEFAULT 0.0,
    LABEL_DELAY_DAYS NUMBER DEFAULT 3, NIGHT_SHIFT BOOLEAN DEFAULT TRUE)
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
  secs NUMBER;
  batch STRING;
BEGIN
  secs := DATEDIFF(second, :START_TS, :END_TS);
  batch := UUID_STRING();
  CREATE OR REPLACE TEMPORARY TABLE OPS.TMP_GEN AS
  WITH g AS (
    SELECT SEQ8() AS rn,
           UNIFORM(0::FLOAT,1::FLOAT,RANDOM()) AS u_fraud,
           UNIFORM(0::FLOAT,1::FLOAT,RANDOM()) AS u_card,
           UNIFORM(0::FLOAT,1::FLOAT,RANDOM()) AS u_burst,
           UNIFORM(0::FLOAT,1::FLOAT,RANDOM()) AS u_night,
           UNIFORM(0::FLOAT,1::FLOAT,RANDOM()) AS u_ch,
           DATEADD(second, UNIFORM(0, :secs - 1, RANDOM()), :START_TS) AS ts0,
           UNIFORM(1,50000,RANDOM()) AS legacy_card,
           UNIFORM(50001,70000,RANDOM()) AS new_card,
           UNIFORM(0,624,RANDOM()) AS m_slot,
           UNIFORM(0,4999,RANDOM()) AS m_any,
           NORMAL(0,0.45,RANDOM()) AS z_amt,
           UNIFORM(4::FLOAT,14::FLOAT,RANDOM()) AS fraud_mult,
           UNIFORM(0,4,RANDOM()) AS night_hr
    FROM TABLE(GENERATOR(ROWCOUNT => :N))
  ), c AS (
    SELECT g.*,
           IFF(u_card < 0.33, new_card, legacy_card) AS card_id,
           (u_fraud < :FRAUD_RATE) AS is_fraud_base,
           (:BURST_CATEGORY IS NOT NULL AND u_burst < :BURST_RATE) AS is_burst
    FROM g
  )
  SELECT UUID_STRING() AS txn_id, c.card_id, cd.customer_id,
         CASE
           WHEN is_burst THEN (SELECT MIN(merchant_id) FROM RAW.MERCHANTS) -- replaced below
           WHEN is_fraud_base AND m_any % 2 = 0 THEN m_any
           ELSE cu.state_idx + 8 * m_slot
         END AS merchant_id0,
         m_any, is_burst,
         IFF(:NIGHT_SHIFT AND is_fraud_base AND u_night < 0.6,
             DATEADD(second, DATEDIFF(second, DATE_TRUNC(hour, ts0), ts0),
                     DATEADD(hour, night_hr, DATE_TRUNC(day, ts0))), ts0) AS txn_ts,
         ROUND(cu.base_spend * EXP(z_amt) * IFF(is_fraud_base OR is_burst, fraud_mult, 1), 2) AS amount,
         CASE WHEN is_fraud_base OR is_burst THEN IFF(u_ch < 0.7,'ONLINE','POS')
              WHEN u_ch < 0.65 THEN 'POS' WHEN u_ch < 0.95 THEN 'ONLINE' ELSE 'ATM' END AS channel,
         (is_fraud_base OR is_burst) AS is_fraud
  FROM c
  JOIN RAW.CARDS cd ON cd.card_id = c.card_id
  JOIN RAW.CUSTOMERS cu ON cu.customer_id = cd.customer_id
  WHERE c.ts0 >= cd.issued_dt;

  -- burst: route to a merchant in the requested category (a genuine, category-concentrated attack)
  IF (:BURST_CATEGORY IS NOT NULL) THEN
    UPDATE OPS.TMP_GEN t SET merchant_id0 = m.merchant_id
    FROM (SELECT merchant_id, ROW_NUMBER() OVER (ORDER BY merchant_id) - 1 AS k,
                 COUNT(*) OVER () AS cnt
          FROM RAW.MERCHANTS WHERE category = :BURST_CATEGORY) m
    WHERE t.is_burst AND m.k = MOD(t.m_any, m.cnt);
  END IF;

  INSERT INTO RAW.TRANSACTIONS
  SELECT txn_id, card_id, customer_id, merchant_id0, txn_ts, amount, channel, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
  FROM OPS.TMP_GEN;

  INSERT INTO RAW.FRAUD_GROUND_TRUTH
  SELECT txn_id, is_fraud, DATEADD(day, :LABEL_DELAY_DAYS, txn_ts) FROM OPS.TMP_GEN;

  RETURN 'generated ' || (SELECT COUNT(*) FROM OPS.TMP_GEN) || ' rows';
END;
$$;

-- 60 days of history (~2.2M rows)
TRUNCATE TABLE IF EXISTS RAW.TRANSACTIONS;
TRUNCATE TABLE IF EXISTS RAW.FRAUD_GROUND_TRUTH;
TRUNCATE TABLE IF EXISTS RAW.FRAUD_LABELS;
CALL OPS.GENERATE_TRANSACTIONS('2026-09-22 00:00:00', DATEADD(minute,-10,DATE_TRUNC(minute,CURRENT_TIMESTAMP()))::TIMESTAMP_NTZ, 2300000);

INSERT INTO RAW.FRAUD_LABELS SELECT * FROM RAW.FRAUD_GROUND_TRUTH WHERE labelled_at <= CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;
