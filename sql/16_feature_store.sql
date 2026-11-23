-- 16 Feature Store: entity-keyed, versioned feature views feed the fraud model.
--    The feature set file in git (pipeline/features/feature_set.sql) names the views and
--    versions; OPS.DEPLOY_FEATURE_SET registers them and makes the set live.
--    FEATURES.FEATURE_SET_SQL builds the model inputs for any set (serving, the agent's
--    what-if tool and training all use it, so there is one code path).
USE ROLE ACCOUNTADMIN;
USE DATABASE FRAUD_AUTOML_DEMO;
USE WAREHOUSE FRAUD_WH;

CREATE SCHEMA IF NOT EXISTS FEATURE_STORE;

-- Every registered feature view version (definitions are immutable once registered)
CREATE TABLE IF NOT EXISTS OPS.FEATURE_VIEW_VERSIONS (
  view_name STRING, view_version STRING, object_name STRING, entity STRING, join_key STRING,
  timestamp_col STRING, features ARRAY, description STRING, query STRING,
  commit_sha STRING, registered_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);

-- Which view versions make up each feature set version
CREATE TABLE IF NOT EXISTS OPS.FEATURE_SETS (
  set_version STRING, view_name STRING, view_version STRING, commit_sha STRING,
  registered_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);

-- The live feature set (OPS.ACTIVE_COMPONENTS 'feature_pipeline' is kept in step for
-- the prediction stamps, monitoring and Mission Control)
CREATE TABLE IF NOT EXISTS OPS.ACTIVE_FEATURE_SET (set_version STRING, updated_at TIMESTAMP_NTZ);

-- Register a feature set file: entities, any new feature view versions, the set's members.
CREATE OR REPLACE PROCEDURE OPS.REGISTER_FEATURE_SET(SOURCE STRING, COMMIT_SHA STRING)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'snowflake-ml-python')
HANDLER = 'run'
EXECUTE AS CALLER
AS
$$
import json
import re
from snowflake.ml.feature_store import CreationMode, Entity, FeatureStore, FeatureView

DB, FS_SCHEMA, WH = "FRAUD_AUTOML_DEMO", "FEATURE_STORE", "FRAUD_WH"
ENTITIES = {"CUSTOMER": "CUSTOMER_ID", "CARD": "CARD_ID", "MERCHANT": "MERCHANT_ID"}
HDR = re.compile(r"^-- @feature_view (\w+)/(\w+)((?: \w+=\w+)*)\s*$", re.M)


def norm(q):
    return re.sub(r"\s+", " ", q or "").strip().upper()


def parse(source):
    ver = re.search(r"-- VERSION: (\w+)", source).group(1).upper()
    uses = [tuple(u.strip().upper().split("/")) for u in re.search(r"-- USES: (.+)", source).group(1).split(",")]
    heads = list(HDR.finditer(source))
    views = {}
    for i, m in enumerate(heads):
        body = source[m.end(): heads[i + 1].start() if i + 1 < len(heads) else len(source)]
        opts = dict(kv.split("=") for kv in m.group(3).split())
        desc = re.search(r"^-- desc: (.+)$", body, re.M)
        query = "\n".join(l for l in body.splitlines() if not l.strip().startswith("--")).strip().rstrip(";").strip()
        views[(m.group(1).upper(), m.group(2).upper())] = {
            "entity": opts["entity"].upper(), "ts": (opts.get("timestamp") or "").upper() or None,
            "desc": desc.group(1).strip() if desc else "", "query": query}
    return ver, uses, views


def run(session, source, commit_sha):
    ver, uses, views = parse(source)
    missing = [f"{n}/{v}" for n, v in uses if (n, v) not in views]
    if missing:
        raise ValueError(f"USES names views with no definition: {missing}")
    fs = FeatureStore(session, DB, FS_SCHEMA, WH, creation_mode=CreationMode.CREATE_IF_NOT_EXIST)
    have = {r["NAME"] for r in fs.list_entities().collect()}
    for name, key in ENTITIES.items():
        if name not in have:
            fs.register_entity(Entity(name=name, join_keys=[key], desc=f"{name.lower()} ({key.lower()})"))

    new = []
    for n, v in uses:
        d = views[(n, v)]
        if d["entity"] not in ENTITIES:
            raise ValueError(f"{n}/{v}: unknown entity {d['entity']}")
        row = session.sql("SELECT query FROM OPS.FEATURE_VIEW_VERSIONS WHERE view_name = ? AND view_version = ?",
                          params=[n, v]).collect()
        if row:
            if norm(row[0][0]) != norm(d["query"]):
                raise ValueError(f"feature view {n}/{v} is already registered with a different definition; "
                                 "add the change under a new version")
            continue
        df = session.sql(d["query"])
        try:
            fv = fs.get_feature_view(n, v)
        except Exception:
            fv = fs.register_feature_view(
                FeatureView(name=n, entities=[fs.get_entity(d["entity"])], feature_df=df,
                            timestamp_col=d["ts"], refresh_freq="1 hour" if d["ts"] else None,
                            desc=d["desc"]),
                version=v, block=True)
        key = ENTITIES[d["entity"]]
        cols = [c.strip('"').upper() for c in df.columns]
        feats = [c for c in cols if c not in (key, d["ts"])]
        session.sql("""INSERT INTO OPS.FEATURE_VIEW_VERSIONS
                         (view_name, view_version, object_name, entity, join_key, timestamp_col, features,
                          description, query, commit_sha)
                       SELECT ?, ?, ?, ?, ?, NULLIF(?, ''), PARSE_JSON(?), ?, ?, ?""",
                    params=[n, v, f'{DB}.{FS_SCHEMA}."{n}${v}"', d["entity"], key, d["ts"] or "",
                            json.dumps(feats), d["desc"], d["query"], commit_sha]).collect()
        new.append(f"{n}/{v}")

    session.sql("DELETE FROM OPS.FEATURE_SETS WHERE set_version = ?", params=[ver]).collect()
    for n, v in uses:
        session.sql("INSERT INTO OPS.FEATURE_SETS (set_version, view_name, view_version, commit_sha) SELECT ?, ?, ?, ?",
                    params=[ver, n, v, commit_sha]).collect()
    return (f"feature set {ver} = {', '.join(f'{n}/{v}' for n, v in uses)}; "
            f"new feature views: {', '.join(new) or 'none'}")
$$;

-- CI deploy hook (same contract as every COMPONENT_DEPLOY procedure)
CREATE OR REPLACE PROCEDURE OPS.DEPLOY_FEATURE_SET(
  VERSION STRING, COMMIT_SHA STRING, AUTHOR STRING, MESSAGE STRING, SOURCE STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
  prev STRING;
  res STRING;
BEGIN
  SELECT MAX(set_version) INTO :prev FROM FRAUD_AUTOML_DEMO.OPS.ACTIVE_FEATURE_SET;
  CALL FRAUD_AUTOML_DEMO.OPS.REGISTER_FEATURE_SET(:SOURCE, :COMMIT_SHA) INTO :res;
  DELETE FROM FRAUD_AUTOML_DEMO.OPS.ACTIVE_FEATURE_SET;
  INSERT INTO FRAUD_AUTOML_DEMO.OPS.ACTIVE_FEATURE_SET VALUES (UPPER(:VERSION), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);
  DELETE FROM FRAUD_AUTOML_DEMO.OPS.ACTIVE_COMPONENTS WHERE component = 'feature_pipeline';
  INSERT INTO FRAUD_AUTOML_DEMO.OPS.ACTIVE_COMPONENTS VALUES ('feature_pipeline', UPPER(:VERSION), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);
  INSERT INTO FRAUD_AUTOML_DEMO.MONITORING.PIPELINE_CHANGE_LOG
    (component, object_name, version, previous_version, commit_sha, author, message, source_sql)
  VALUES ('feature_pipeline', 'FEATURE_STORE feature set ' || UPPER(:VERSION), UPPER(:VERSION), :prev,
          :COMMIT_SHA, :AUTHOR, :MESSAGE, :SOURCE);
  RETURN 'deployed feature set ' || UPPER(:VERSION) || ' (previous ' || COALESCE(:prev, 'none') || '): ' || :res;
END;
$$;

-- Switch the live feature set to one that is already registered (approved rollback action)
CREATE OR REPLACE PROCEDURE OPS.ACTIVATE_FEATURE_SET(VERSION STRING, ACTOR STRING, REASON STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  prev STRING;
  n NUMBER;
BEGIN
  SELECT COUNT(*) INTO :n FROM OPS.FEATURE_SETS WHERE set_version = UPPER(:VERSION);
  IF (:n = 0) THEN
    RETURN 'error: feature set ' || UPPER(:VERSION) || ' is not registered';
  END IF;
  SELECT MAX(set_version) INTO :prev FROM OPS.ACTIVE_FEATURE_SET;
  DELETE FROM OPS.ACTIVE_FEATURE_SET;
  INSERT INTO OPS.ACTIVE_FEATURE_SET VALUES (UPPER(:VERSION), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);
  DELETE FROM OPS.ACTIVE_COMPONENTS WHERE component = 'feature_pipeline';
  INSERT INTO OPS.ACTIVE_COMPONENTS VALUES ('feature_pipeline', UPPER(:VERSION), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);
  INSERT INTO MONITORING.PIPELINE_CHANGE_LOG (component, object_name, version, previous_version, author, message)
  VALUES ('feature_pipeline', 'FEATURE_STORE feature set ' || UPPER(:VERSION), UPPER(:VERSION), :prev,
          :ACTOR, 'Activate feature set ' || UPPER(:VERSION) || ': ' || COALESCE(:REASON, ''));
  RETURN 'active feature set ' || UPPER(:VERSION) || ' (previous ' || COALESCE(:prev, 'none') || ')';
END;
$$;

-- Build the model inputs for [START_TS, END_TS) from a feature set. Returns a SELECT.
--   OPTIONS: {"swap": "VIEW/VER"}  replace the member view that provides the same features
--            {"asof": "<ts>"}      read the RAW tables behind non-timestamped views as of <ts>
--            {"spine_only": true}  only the transaction-level columns (training spine)
CREATE OR REPLACE PROCEDURE FEATURES.FEATURE_SET_SQL(
  SET_VERSION STRING, START_TS STRING, END_TS STRING, OPTIONS VARIANT)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
EXECUTE AS OWNER
AS
$$
import json
import re

DB = "FRAUD_AUTOML_DEMO"
SAFE = re.compile(r"^[A-Za-z0-9_]+$")
TS = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$")
VIEW_SQL = ("SELECT v.view_name, v.view_version, v.object_name, v.entity, v.join_key, v.timestamp_col, "
            "v.features, v.query FROM OPS.FEATURE_VIEW_VERSIONS v ")


def load(rows):
    return [{"name": r[0], "ver": r[1], "obj": r[2], "entity": r[3], "key": r[4], "ts": r[5],
             "features": json.loads(r[6]) if isinstance(r[6], str) else list(r[6]), "query": r[7]} for r in rows]


def run(session, set_version, s, e, options):
    opts = json.loads(options) if isinstance(options, str) else (options if isinstance(options, dict) else {})
    sv = (set_version or "").upper()
    if not SAFE.match(sv) or not TS.match(s or "") or not TS.match(e or ""):
        raise ValueError("bad set version or timestamps")
    spine = (f"WITH hist AS (SELECT t.* FROM {DB}.RAW.TRANSACTIONS t "
             f"WHERE t.txn_ts >= DATEADD(day, -30, '{s}'::TIMESTAMP_NTZ) AND t.txn_ts < '{e}'::TIMESTAMP_NTZ), "
             "w AS (SELECT h.txn_id, h.card_id, h.customer_id, h.merchant_id, h.txn_ts, h.amount, h.channel, "
             "COUNT(*) OVER (PARTITION BY h.card_id ORDER BY h.txn_ts "
             "RANGE BETWEEN INTERVAL '1 hour' PRECEDING AND CURRENT ROW) AS txn_count_1h, "
             "COUNT(*) OVER (PARTITION BY h.card_id ORDER BY h.txn_ts "
             "RANGE BETWEEN INTERVAL '24 hours' PRECEDING AND CURRENT ROW) AS txn_count_24h, "
             "IFF(ROW_NUMBER() OVER (PARTITION BY h.customer_id, h.merchant_id ORDER BY h.txn_ts) = 1, 1, 0) "
             "AS is_new_merchant FROM hist h) ")
    window = f"w.txn_ts >= '{s}'::TIMESTAMP_NTZ AND w.txn_ts < '{e}'::TIMESTAMP_NTZ"
    if opts.get("spine_only"):
        return (spine + "SELECT w.txn_id, w.card_id, w.customer_id, w.merchant_id, w.txn_ts, "
                "w.amount::FLOAT AS amount, w.txn_count_1h, w.txn_count_24h, w.is_new_merchant, "
                "HOUR(w.txn_ts) AS hour_of_day, IFF(w.channel = 'ONLINE', 1, 0) AS is_online "
                f"FROM w WHERE {window}")

    views = load(session.sql(VIEW_SQL + "JOIN OPS.FEATURE_SETS s ON s.view_name = v.view_name "
                             "AND s.view_version = v.view_version WHERE s.set_version = ? ORDER BY v.view_name",
                             params=[sv]).collect())
    if not views:
        raise ValueError(f"feature set {sv} is not registered")
    if opts.get("swap"):
        n, v = (opts["swap"].upper().split("/") + [""])[:2]
        if not (SAFE.match(n) and SAFE.match(v)):
            raise ValueError("swap must be VIEW/VERSION")
        new = load(session.sql(VIEW_SQL + "WHERE v.view_name = ? AND v.view_version = ?", params=[n, v]).collect())
        if not new:
            raise ValueError(f"feature view {n}/{v} is not registered")
        views = [x for x in views if x["name"] != n and not set(x["features"]) & set(new[0]["features"])] + new
    asof = opts.get("asof")
    if asof and not TS.match(asof):
        raise ValueError("asof must be a timestamp")

    joins, src = [], {}
    for i, v in enumerate(views):
        a, obj = f"v{i}", v["obj"]
        if asof and not v["ts"]:
            q = re.sub(rf"\b{DB}\.RAW\.(\w+)\b",
                       lambda m: m.group(0) if m.group(1).upper() == "TRANSACTIONS"
                       else f"{m.group(0)} AT(TIMESTAMP => '{asof}'::TIMESTAMP_LTZ)",
                       v["query"], flags=re.I)
            obj = f"({q})"
        if v["ts"]:
            joins.append(f"ASOF JOIN {obj} {a} MATCH_CONDITION(w.txn_ts >= {a}.{v['ts']}) "
                         f"ON w.{v['key']} = {a}.{v['key']}")
        else:
            joins.append(f"LEFT JOIN {obj} {a} ON {a}.{v['key']} = w.{v['key']}")
        for f in v["features"]:
            src.setdefault(f, a)

    def c(name):
        return f"{src[name]}.{name}" if name in src else "NULL"

    return (spine +
            "SELECT w.txn_id, w.card_id, w.customer_id, w.merchant_id, w.txn_ts, w.amount::FLOAT AS amount, "
            f"{c('CUST_AVG_AMT_30D')}::FLOAT AS cust_avg_amt_30d, "
            f"(w.amount / COALESCE({c('CUST_AVG_AMT_30D')}, 1))::FLOAT AS amt_to_cust_avg_30d, "
            "w.txn_count_1h, w.txn_count_24h, "
            f"HAVERSINE({c('HOME_LAT')}, {c('HOME_LON')}, {c('MERCH_LAT')}, {c('MERCH_LON')})::FLOAT "
            "AS distance_from_home_km, "
            f"{c('MERCHANT_RISK_SCORE')}::FLOAT AS merchant_risk_score, w.is_new_merchant, "
            "HOUR(w.txn_ts) AS hour_of_day, IFF(w.channel = 'ONLINE', 1, 0) AS is_online, "
            f"{c('MERCHANT_CATEGORY')}::STRING AS merchant_category, "
            f"{c('ISSUING_PLATFORM')}::STRING AS issuing_platform, "
            f"{c('CARD_ISSUED_DT')}::DATE AS card_issued_dt, {c('HOME_STATE')}::STRING AS home_state "
            f"FROM w {' '.join(joins)} WHERE {window}")
$$;

-- Bring the set's managed (timestamped) feature views up to date before scoring
CREATE OR REPLACE PROCEDURE OPS.REFRESH_FEATURE_SET(SET_VERSION STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  out STRING DEFAULT '';
BEGIN
  LET rs RESULTSET := (SELECT v.object_name FROM OPS.FEATURE_VIEW_VERSIONS v
                       JOIN OPS.FEATURE_SETS s ON s.view_name = v.view_name AND s.view_version = v.view_version
                       WHERE s.set_version = UPPER(:SET_VERSION) AND v.timestamp_col IS NOT NULL);
  LET c CURSOR FOR rs;
  FOR rec IN c DO
    LET obj STRING := rec.object_name;
    EXECUTE IMMEDIATE 'ALTER DYNAMIC TABLE ' || :obj || ' REFRESH';
    out := out || :obj || ' ';
  END FOR;
  RETURN 'refreshed ' || :out;
END;
$$;

-- Read access for the agent (investigation) and Mission Control
GRANT USAGE ON SCHEMA FEATURE_STORE TO ROLE FRAUD_AGENT_RO;
GRANT SELECT ON ALL VIEWS IN SCHEMA FEATURE_STORE TO ROLE FRAUD_AGENT_RO;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA FEATURE_STORE TO ROLE FRAUD_AGENT_RO;
GRANT SELECT ON ALL DYNAMIC TABLES IN SCHEMA FEATURE_STORE TO ROLE FRAUD_AGENT_RO;
GRANT SELECT ON FUTURE DYNAMIC TABLES IN SCHEMA FEATURE_STORE TO ROLE FRAUD_AGENT_RO;
GRANT SELECT ON TABLE OPS.FEATURE_VIEW_VERSIONS TO ROLE FRAUD_AGENT_RO;
GRANT SELECT ON TABLE OPS.FEATURE_SETS TO ROLE FRAUD_AGENT_RO;
GRANT SELECT ON TABLE OPS.ACTIVE_FEATURE_SET TO ROLE FRAUD_AGENT_RO;
