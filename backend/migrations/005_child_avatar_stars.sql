-- The child's avatar (the design from My Avatar, what she owns and has spent), her portrait, and the stars she
-- has earned in each app. All of it belongs to the child profile, so it follows her to any tablet.
ALTER TABLE child
  ADD COLUMN avatar jsonb,
  ADD COLUMN avatar_saved_at timestamptz,
  ADD COLUMN portrait_key text,
  ADD COLUMN portrait_updated_at timestamptz;

CREATE TABLE child_stars (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  child_id text NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  earned integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (child_id, app_id)
);
CREATE INDEX child_stars_family_idx ON child_stars (family_id);

ALTER TABLE child_stars ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON child_stars
  USING (family_id = current_setting('app.family_id', true))
  WITH CHECK (family_id = current_setting('app.family_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON child_stars TO duckling_app;
