-- 03 Pipeline deploy machinery + change log
USE ROLE ACCOUNTADMIN;
USE DATABASE FRAUD_AUTOML_DEMO;

-- Every deploy of any pipeline component lands here (written by CI)
CREATE TABLE IF NOT EXISTS MONITORING.PIPELINE_CHANGE_LOG (
  change_id STRING DEFAULT UUID_STRING(),
  component STRING,           -- feature_pipeline | model | upstream_schema
  object_name STRING,
  version STRING,
  previous_version STRING,
  commit_sha STRING,
  author STRING,
  message STRING,
  source_sql STRING,
  deployed_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
);

-- Which version of each component is live. 'feature_pipeline' mirrors OPS.ACTIVE_FEATURE_SET
-- (sql/16_feature_store.sql) and is written by OPS.DEPLOY_FEATURE_SET / ACTIVATE_FEATURE_SET.
CREATE TABLE IF NOT EXISTS OPS.ACTIVE_COMPONENTS (
  component STRING, version STRING, updated_at TIMESTAMP_NTZ
);
-- Feature deploys now go through the Feature Store: see OPS.DEPLOY_FEATURE_SET in
-- sql/16_feature_store.sql. (The former OPS.DEPLOY_FEATURE_PIPELINE created one
-- FEATURES.FN_TXN_FEATURES_<VERSION> table function per version.)
