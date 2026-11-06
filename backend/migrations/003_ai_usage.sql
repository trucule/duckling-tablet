-- AI calls per device, per app, per day (cost cap for the Anthropic proxy). Counts and tokens only: prompts and
-- replies are never stored.
CREATE TABLE ai_usage (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  day date NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, app_id, day)
);
CREATE INDEX ai_usage_family_idx ON ai_usage (family_id);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON ai_usage
  USING (family_id = current_setting('app.family_id', true))
  WITH CHECK (family_id = current_setting('app.family_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_usage TO duckling_app;
