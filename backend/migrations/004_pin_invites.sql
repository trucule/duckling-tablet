-- The family PIN and second-parent invites.
-- pin_hash: HMAC with the server secret, for online checks. pin_sync: SHA-256 of "duckling:<pin>", the form the
-- shells keep locally, sent in the device config so a PIN set on the website works on every tablet offline.
ALTER TABLE family ADD COLUMN pin_hash text, ADD COLUMN pin_sync text, ADD COLUMN pin_set_at timestamptz;

-- A sign-in link made by an invite joins the new parent to this family instead of making a family of their own.
ALTER TABLE login_token ADD COLUMN invite_family_id text REFERENCES family(id) ON DELETE CASCADE;

CREATE FUNCTION create_invite_token(p_token_hash text, p_email text, p_expires_at timestamptz, p_family_id text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  INSERT INTO login_token (token_hash, email, expires_at, invite_family_id) VALUES (p_token_hash, p_email, p_expires_at, p_family_id);
$$;

DROP FUNCTION redeem_login_token(text);
CREATE FUNCTION redeem_login_token(p_token_hash text)
RETURNS TABLE (email text, invite_family_id text) LANGUAGE sql SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  UPDATE login_token SET used_at = now()
  WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  RETURNING login_token.email, login_token.invite_family_id;
$$;

-- Joins an invited address to the family: a new parent row, or the existing one when the address already belongs
-- to this family. An address that already has another family is refused (joined = false).
CREATE FUNCTION join_family(p_email text, p_family_id text, p_parent_id text)
RETURNS TABLE (parent_id text, family_id text, joined boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = duckling, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT p.id, p.family_id INTO r FROM parent p WHERE lower(p.email) = lower(p_email);
  IF FOUND THEN
    RETURN QUERY SELECT r.id, r.family_id, r.family_id = p_family_id;
    RETURN;
  END IF;
  INSERT INTO parent (id, family_id, email, role) VALUES (p_parent_id, p_family_id, p_email, 'parent');
  RETURN QUERY SELECT p_parent_id, p_family_id, true;
END $$;

REVOKE EXECUTE ON FUNCTION create_invite_token(text, text, timestamptz, text), redeem_login_token(text), join_family(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_invite_token(text, text, timestamptz, text), redeem_login_token(text), join_family(text, text, text) TO duckling_app;
