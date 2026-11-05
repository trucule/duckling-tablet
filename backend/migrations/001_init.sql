-- Duckling Tablet schema, version 1. Times are ISO-8601 UTC text. Ids are random text ids.
CREATE TABLE family (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE parent (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL
);

-- One-time sign-in links (only the hash is stored).
CREATE TABLE login_token (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE session (
  token_hash TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- The child profile holds only what the apps need: first name, grade, starting levels, theme.
CREATE TABLE child (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  grade TEXT,
  levels TEXT NOT NULL DEFAULT '{}',
  theme TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE pairing_code (
  code TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  child_id TEXT REFERENCES child(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE device (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  child_id TEXT REFERENCES child(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'windows', 'web')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  shell_version TEXT,
  push_token TEXT,
  battery INTEGER,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'release', 'released')),
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE app (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  subjects TEXT NOT NULL DEFAULT '[]',
  age_min INTEGER,
  age_max INTEGER,
  starter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE app_version (
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  package_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,
  size INTEGER NOT NULL,
  min_shell TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  published_at TEXT NOT NULL,
  PRIMARY KEY (app_id, version)
);

CREATE TABLE device_app (
  device_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (device_id, app_id)
);

-- Apps a parent hid from a device's Store and home screen.
CREATE TABLE device_hidden_app (
  device_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, app_id)
);

-- Per-device settings as JSON values: allowlist, travel_until, limits, pin_hash.
CREATE TABLE setting (
  device_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (device_id, key)
);

CREATE TABLE app_request (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  child_grade TEXT,
  install_when_ready INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'planned', 'building', 'declined', 'shipped')),
  etducky_ticket_id TEXT,
  app_id TEXT REFERENCES app(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Shared voice clip cache index; the MP3 itself lives in storage under voice/<hash>.mp3.
CREATE TABLE voice_clip (
  hash TEXT PRIMARY KEY,
  voice TEXT NOT NULL,
  rate INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Uncached speech characters per device per day (cost cap).
CREATE TABLE tts_usage (
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, day)
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);

CREATE INDEX idx_parent_family ON parent(family_id);
CREATE INDEX idx_child_family ON child(family_id);
CREATE INDEX idx_device_family ON device(family_id);
CREATE INDEX idx_request_family ON app_request(family_id);
CREATE INDEX idx_audit_family ON audit(family_id);
