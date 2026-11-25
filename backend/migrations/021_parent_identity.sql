-- Sign in with Apple, Google or Microsoft. Each row ties one provider account (its stable subject id) to a parent,
-- and so to the family. A parent has at most one of each provider; the email the provider gave is kept to show in
-- the portal (an Apple private relay address stays as it came). Signing in with a linked account on any tablet adds
-- that tablet to the family.
CREATE TABLE parent_identity (
  provider text NOT NULL CHECK (provider IN ('apple', 'google', 'microsoft')),
  subject text NOT NULL,
  parent_id text NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
  family_id text NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  UNIQUE (parent_id, provider)
);
CREATE INDEX parent_identity_family_idx ON parent_identity (family_id);

ALTER TABLE parent_identity ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON parent_identity
  USING (family_id = current_setting('app.family_id', true)) WITH CHECK (family_id = current_setting('app.family_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON parent_identity TO duckling_app;

-- The parent a provider account belongs to, before any family is known (at sign-in).
CREATE FUNCTION find_identity(p_provider text, p_subject text)
RETURNS TABLE (parent_id text, family_id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = duckling, pg_temp AS $$
  SELECT parent_id, family_id FROM parent_identity WHERE provider = p_provider AND subject = p_subject
$$;
REVOKE EXECUTE ON FUNCTION find_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_identity(text, text) TO duckling_app;
