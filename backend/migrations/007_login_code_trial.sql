-- One-device signup: a six-digit code by email, typed on the tablet. And the free trial, started when a family is
-- created, as the first entitlement row.
CREATE TABLE login_code (
  id text PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_code_email_idx ON login_code (lower(email), created_at DESC);

CREATE FUNCTION create_login_code(p_id text, p_email text, p_code_hash text, p_expires_at timestamptz)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  INSERT INTO login_code (id, email, code_hash, expires_at) VALUES (p_id, p_email, p_code_hash, p_expires_at);
$$;

-- Checks a code against the address's newest live code. A match uses it up; a miss counts against it, and five
-- misses end it. Returns true only on a match.
CREATE FUNCTION redeem_login_code(p_email text, p_code_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM login_code
    WHERE lower(email) = lower(p_email) AND used_at IS NULL AND expires_at > now() AND attempts < 5
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF r.code_hash = p_code_hash THEN
    UPDATE login_code SET used_at = now() WHERE id = r.id;
    RETURN true;
  END IF;
  UPDATE login_code SET attempts = attempts + 1 WHERE id = r.id;
  RETURN false;
END $$;

-- The free trial: one entitlement row per new family. Does nothing for a family that already has one.
CREATE FUNCTION start_trial(p_family_id text, p_days integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  INSERT INTO entitlement (family_id, status, source, current_period_end)
  VALUES (p_family_id, 'trial', 'trial', now() + make_interval(days => p_days))
  ON CONFLICT (family_id) DO NOTHING;
$$;

REVOKE EXECUTE ON FUNCTION create_login_code(text, text, text, timestamptz), redeem_login_code(text, text), start_trial(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_login_code(text, text, text, timestamptz), redeem_login_code(text, text), start_trial(text, integer) TO duckling_app;
