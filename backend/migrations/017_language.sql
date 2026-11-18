-- The language a family's tablets, portal pages and emails use, set at signup from the parent's device and changed in
-- the portal or the tablet's parent area. A child may have her own (a bilingual family); null means the family's.
ALTER TABLE family ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es'));
ALTER TABLE child ADD COLUMN language text CHECK (language IN ('en', 'es'));
