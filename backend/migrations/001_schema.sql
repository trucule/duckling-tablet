-- Duckling Tablet schema on PostgreSQL, version 1. Runs as duckling_system (the owner) inside schema "duckling",
-- after bootstrap.sql has created the roles and the schema. Ids are random prefixed text ids made by the API
-- (fam_, par_, chd_, dev_, req_); times are timestamptz; JSON columns are jsonb.
--
-- Family-owned tables carry family_id and a row-level security policy keyed on the transaction-local setting
-- app.family_id. duckling_app is not the owner, so the policies apply to every one of its queries. With no setting,
-- current_setting('app.family_id', true) is null and no row matches.

CREATE TABLE family (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE parent (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'owner',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX parent_email_key ON parent (lower(email));
CREATE INDEX parent_family_idx ON parent (family_id);

-- One-time sign-in links (only the hash is stored). Global: reached through functions only.
CREATE TABLE login_token (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE session (
  token_hash text PRIMARY KEY,
  parent_id text NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX session_parent_idx ON session (parent_id);

-- The child profile holds only what the apps need: first name, grade, starting levels, theme.
CREATE TABLE child (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  first_name text NOT NULL,
  grade text,
  levels jsonb NOT NULL DEFAULT '{}'::jsonb,
  theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX child_family_idx ON child (family_id);

CREATE TABLE pairing_code (
  code text PRIMARY KEY,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  child_id text REFERENCES child(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX pairing_code_family_idx ON pairing_code (family_id);

CREATE TABLE device (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  child_id text REFERENCES child(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('android', 'ios', 'windows', 'web')),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  shell_version text,
  push_token text,
  battery integer,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'release', 'released')),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_family_idx ON device (family_id);

-- The catalog. Global: duckling_app reads it; publishing writes it as duckling_system.
CREATE TABLE app (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  subjects jsonb NOT NULL DEFAULT '[]'::jsonb,
  age_min integer,
  age_max integer,
  starter boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_version (
  app_id text NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  version text NOT NULL,
  package_key text NOT NULL,
  sha256 text NOT NULL,
  signature text NOT NULL,
  size bigint NOT NULL,
  min_shell text,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, version)
);

CREATE TABLE device_app (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, app_id)
);
CREATE INDEX device_app_family_idx ON device_app (family_id);

-- Apps a parent hid from a device's Store and home screen.
CREATE TABLE device_hidden_app (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, app_id)
);
CREATE INDEX device_hidden_app_family_idx ON device_hidden_app (family_id);

-- Per-device settings as JSON values: allowlist, travel_until, limits, pin_hash.
CREATE TABLE setting (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (device_id, key)
);
CREATE INDEX setting_family_idx ON setting (family_id);

CREATE TABLE app_request (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL,
  child_grade text,
  install_when_ready boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'planned', 'building', 'declined', 'shipped')),
  etducky_ticket_id text,
  app_id text REFERENCES app(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_request_family_idx ON app_request (family_id);
CREATE INDEX app_request_ticket_idx ON app_request (etducky_ticket_id);

-- Files attached to a request; private in Spaces, served by short-lived signed URLs.
CREATE TABLE request_attachment (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  request_id text NOT NULL REFERENCES app_request(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_attachment_family_idx ON request_attachment (family_id);

-- Billing state. The billing module writes these as duckling_system; the API reads them for the family.
CREATE TABLE entitlement (
  family_id text PRIMARY KEY REFERENCES family(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('trial', 'active', 'grace', 'ended', 'none')),
  source text,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('google', 'apple', 'stripe')),
  external_id text NOT NULL UNIQUE,
  product_id text NOT NULL,
  status text NOT NULL,
  period_end timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_family_idx ON purchase (family_id);

-- Shared voice clip cache index; the MP3 itself lives in storage under voice/<hash>.mp3. Global.
CREATE TABLE voice_clip (
  hash text PRIMARY KEY,
  voice text NOT NULL,
  rate integer NOT NULL,
  chars integer NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Uncached speech characters per device per day (cost cap).
CREATE TABLE tts_usage (
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  day date NOT NULL,
  chars integer NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, day)
);
CREATE INDEX tts_usage_family_idx ON tts_usage (family_id);

CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id text,
  actor text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_family_idx ON audit (family_id);

-- A device whose family was deleted keeps a tombstone so its next check-in is told to release the tablet. Global.
CREATE TABLE device_tombstone (
  token_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every webhook (store billing, Stripe, ET Ducky) is recorded here first so a redelivery does nothing twice. Global.
CREATE TABLE webhook_event (
  source text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, event_id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Row-level security. The owner (duckling_system) is not subject to these; duckling_app is.

ALTER TABLE family ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON family
  USING (id = current_setting('app.family_id', true))
  WITH CHECK (id = current_setting('app.family_id', true));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parent', 'session', 'child', 'pairing_code', 'device', 'device_app', 'device_hidden_app',
                           'setting', 'app_request', 'request_attachment', 'entitlement', 'purchase', 'tts_usage', 'audit']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY family_isolation ON %I USING (family_id = current_setting(''app.family_id'', true)) '
                   'WITH CHECK (family_id = current_setting(''app.family_id'', true))', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Lookups that happen before the family is known. SECURITY DEFINER: they run with the owner's rights and return
-- only what the caller needs. Each pins its search_path.

CREATE FUNCTION create_login_token(p_token_hash text, p_email text, p_expires_at timestamptz)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  INSERT INTO login_token (token_hash, email, expires_at) VALUES (p_token_hash, p_email, p_expires_at);
$$;

-- Marks the link used and returns its email; nothing when the link is unknown, used or expired.
CREATE FUNCTION redeem_login_token(p_token_hash text)
RETURNS TABLE (email text) LANGUAGE sql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  UPDATE login_token SET used_at = now()
  WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  RETURNING login_token.email;
$$;

-- Finds the parent by email (case-insensitive) or creates a family and parent with the ids the API made.
CREATE FUNCTION find_or_create_parent(p_email text, p_family_id text, p_parent_id text)
RETURNS TABLE (parent_id text, family_id text, created boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = duckling, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT p.id, p.family_id INTO r FROM parent p WHERE lower(p.email) = lower(p_email);
  IF FOUND THEN
    RETURN QUERY SELECT r.id, r.family_id, false;
    RETURN;
  END IF;
  INSERT INTO family (id) VALUES (p_family_id);
  BEGIN
    INSERT INTO parent (id, family_id, email) VALUES (p_parent_id, p_family_id, p_email);
  EXCEPTION WHEN unique_violation THEN
    -- Two first sign-ins for the same address at the same moment: keep the one that won.
    DELETE FROM family WHERE id = p_family_id;
    SELECT p.id, p.family_id INTO r FROM parent p WHERE lower(p.email) = lower(p_email);
    RETURN QUERY SELECT r.id, r.family_id, false;
    RETURN;
  END;
  RETURN QUERY SELECT p_parent_id, p_family_id, true;
END $$;

CREATE FUNCTION auth_session(p_token_hash text)
RETURNS TABLE (parent_id text, family_id text, email text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  SELECT p.id, p.family_id, p.email, s.expires_at FROM session s JOIN parent p ON p.id = s.parent_id
  WHERE s.token_hash = p_token_hash AND s.expires_at > now();
$$;

-- The device for a token, or a row with released = true when the device's family was deleted.
CREATE FUNCTION auth_device(p_token_hash text)
RETURNS TABLE (device_id text, family_id text, child_id text, state text, released boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  SELECT d.id, d.family_id, d.child_id, d.state, false FROM device d WHERE d.token_hash = p_token_hash
  UNION ALL
  SELECT NULL, NULL, NULL, NULL, true FROM device_tombstone t WHERE t.token_hash = p_token_hash
  LIMIT 1;
$$;

-- Issues a code for the family of the current transaction (app.family_id). Codes are global, and a used or expired
-- code of any family may be reused; a live one may not. Returns false when the code is taken.
CREATE FUNCTION create_pairing_code(p_code text, p_child_id text, p_expires_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
DECLARE fam text := current_setting('app.family_id', true);
BEGIN
  IF fam IS NULL OR fam = '' THEN RAISE EXCEPTION 'create_pairing_code needs app.family_id'; END IF;
  INSERT INTO pairing_code (code, family_id, child_id, expires_at) VALUES (p_code, fam, p_child_id, p_expires_at)
  ON CONFLICT (code) DO UPDATE SET family_id = excluded.family_id, child_id = excluded.child_id, expires_at = excluded.expires_at, used_at = NULL
  WHERE pairing_code.used_at IS NOT NULL OR pairing_code.expires_at <= now();
  RETURN FOUND;
END $$;

-- Marks the code used and returns who it belongs to; nothing when it is unknown, used or expired.
CREATE FUNCTION redeem_pairing_code(p_code text)
RETURNS TABLE (family_id text, child_id text) LANGUAGE sql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  UPDATE pairing_code SET used_at = now()
  WHERE code = p_code AND used_at IS NULL AND expires_at > now()
  RETURNING pairing_code.family_id, pairing_code.child_id;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Grants for duckling_app. Nothing on login_token, device_tombstone or webhook_event.

GRANT SELECT, INSERT, UPDATE, DELETE ON family, parent, session, child, pairing_code, device, device_app,
  device_hidden_app, setting, app_request, request_attachment, tts_usage, audit TO duckling_app;
GRANT SELECT ON app, app_version, voice_clip, entitlement, purchase TO duckling_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA duckling TO duckling_app;

REVOKE EXECUTE ON FUNCTION create_login_token(text, text, timestamptz), redeem_login_token(text),
  find_or_create_parent(text, text, text), auth_session(text), auth_device(text), create_pairing_code(text, text, timestamptz),
  redeem_pairing_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_login_token(text, text, timestamptz), redeem_login_token(text),
  find_or_create_parent(text, text, text), auth_session(text), auth_device(text), create_pairing_code(text, text, timestamptz),
  redeem_pairing_code(text) TO duckling_app;
