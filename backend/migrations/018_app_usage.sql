-- How much each Duckling app is used: opens and seconds per tablet, app and the tablet's local day. The tablet counts
-- from the moment it opens an app to the moment Duckling is back in front. Only counts are kept: no content, no
-- answers, nothing about what the child did inside the app. The owner's stats page sums these across families.
CREATE TABLE app_usage (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  day date NOT NULL,
  opens integer NOT NULL DEFAULT 0,
  seconds integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, app_id, day)
);
CREATE INDEX app_usage_family_idx ON app_usage (family_id);
CREATE INDEX app_usage_day_idx ON app_usage (day);

ALTER TABLE app_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON app_usage
  USING (family_id = current_setting('app.family_id', true)) WITH CHECK (family_id = current_setting('app.family_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON app_usage TO duckling_app;
