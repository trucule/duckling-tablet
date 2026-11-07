-- The About page in the parent portal: what the app trains, how it grows with the child, the life skills, and a
-- short recording of the app in action (uploaded by the publish tool, public on the CDN like the tile).
ALTER TABLE app ADD COLUMN about jsonb, ADD COLUMN demo_key text;
