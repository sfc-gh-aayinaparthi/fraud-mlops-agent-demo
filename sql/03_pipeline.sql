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

-- Which version of each component is live
CREATE TABLE IF NOT EXISTS OPS.ACTIVE_COMPONENTS (
  component STRING, version STRING, updated_at TIMESTAMP_NTZ
);

CREATE OR REPLACE PROCEDURE FRAUD_AUTOML_DEMO.OPS.DEPLOY_FEATURE_PIPELINE(
  VERSION STRING, COMMIT_SHA STRING, AUTHOR STRING, MESSAGE STRING, SOURCE_SQL STRING)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
-- fully qualified: called from other databases (control-plane CD task)
DECLARE
  prev STRING;
  ddl STRING;
BEGIN
  SELECT MAX(version) INTO :prev FROM FRAUD_AUTOML_DEMO.OPS.ACTIVE_COMPONENTS WHERE component = 'feature_pipeline';
  ddl := REPLACE(:SOURCE_SQL, '__VERSION__', UPPER(:VERSION));
  EXECUTE IMMEDIATE :ddl;
  DELETE FROM FRAUD_AUTOML_DEMO.OPS.ACTIVE_COMPONENTS WHERE component = 'feature_pipeline';
  INSERT INTO FRAUD_AUTOML_DEMO.OPS.ACTIVE_COMPONENTS VALUES ('feature_pipeline', UPPER(:VERSION), CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);
  INSERT INTO FRAUD_AUTOML_DEMO.MONITORING.PIPELINE_CHANGE_LOG
    (component, object_name, version, previous_version, commit_sha, author, message, source_sql)
  VALUES ('feature_pipeline', 'FEATURES.FN_TXN_FEATURES_' || UPPER(:VERSION), UPPER(:VERSION), :prev,
          :COMMIT_SHA, :AUTHOR, :MESSAGE, :ddl);
  RETURN 'deployed feature_pipeline ' || UPPER(:VERSION) || ' (previous ' || COALESCE(:prev, 'none') || ')';
END;
$$;
