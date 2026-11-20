-- The catalog in the family's other language. Each app's manifest may carry an i18n block with, per language code,
-- the name, the description and the About text in that language; the publish tool sends it and it is kept here as
-- sent. Tablets and the portal show the entry for the family's language and fall back to the English columns.
ALTER TABLE app ADD COLUMN i18n jsonb;
