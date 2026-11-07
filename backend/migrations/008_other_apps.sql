-- Apps already on the tablet (installed outside Duckling), shown in a section of their own once a parent allows
-- them, each with a daily allowance, an optional time window, and websites that open only while the app has time.
CREATE TABLE device_other_app (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  package text NOT NULL,
  label text NOT NULL,
  icon text,                          -- data URL, a small PNG from the tablet
  present boolean NOT NULL DEFAULT true,
  allowed boolean NOT NULL DEFAULT false,
  daily_minutes integer,              -- null: no daily cap
  window_start text,                  -- "HH:MM" local to the tablet; null: any time
  window_end text,
  hosts jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, package)
);
CREATE INDEX device_other_app_family_idx ON device_other_app (family_id);

CREATE TABLE other_app_usage (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  package text NOT NULL,
  day date NOT NULL,                  -- the tablet's local day, sent by the tablet
  seconds integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, package, day)
);
CREATE INDEX other_app_usage_family_idx ON other_app_usage (family_id);

ALTER TABLE device_other_app ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON device_other_app
  USING (family_id = current_setting('app.family_id', true)) WITH CHECK (family_id = current_setting('app.family_id', true));
ALTER TABLE other_app_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON other_app_usage
  USING (family_id = current_setting('app.family_id', true)) WITH CHECK (family_id = current_setting('app.family_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON device_other_app, other_app_usage TO duckling_app;
