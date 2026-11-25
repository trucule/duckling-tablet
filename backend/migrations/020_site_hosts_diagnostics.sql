-- Hosts an allowed website tried to reach and the tablet refused (its video playlists, pictures, scripts), per
-- tablet and per allowed site. A parent allows one (decision 'allowed': the tablet then lets it through while that
-- site is allowed, with no tile) or keeps it blocked (decision 'blocked': it stops being offered). Only the host
-- names are kept: no addresses, pages or anything the child did there.
CREATE TABLE site_host (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  site text NOT NULL,
  host text NOT NULL,
  media boolean NOT NULL DEFAULT false,
  hits integer NOT NULL DEFAULT 0,
  decision text CHECK (decision IN ('allowed', 'blocked')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  PRIMARY KEY (device_id, site, host)
);
CREATE INDEX site_host_family_idx ON site_host (family_id);

ALTER TABLE site_host ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON site_host
  USING (family_id = current_setting('app.family_id', true)) WITH CHECK (family_id = current_setting('app.family_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON site_host TO duckling_app;

-- A report a parent sent from the tablet's parent area: their note, a short summary, and the full report as a private
-- file in storage. Each one becomes an ET Ducky ticket. The tablet row may go; the report stays with the family.
CREATE TABLE diagnostic_report (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text REFERENCES device(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  storage_key text NOT NULL,
  size integer NOT NULL,
  etducky_ticket_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX diagnostic_report_family_idx ON diagnostic_report (family_id);
CREATE INDEX diagnostic_report_unsent_idx ON diagnostic_report (created_at) WHERE etducky_ticket_id IS NULL;

ALTER TABLE diagnostic_report ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON diagnostic_report
  USING (family_id = current_setting('app.family_id', true)) WITH CHECK (family_id = current_setting('app.family_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON diagnostic_report TO duckling_app;
