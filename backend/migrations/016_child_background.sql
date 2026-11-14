-- The home screen background a child chose from a picture she saved in an app (Paint Studio, Draw With Me). Private in
-- storage like the portrait; devices get a signed link.
ALTER TABLE child ADD COLUMN background_key text;
