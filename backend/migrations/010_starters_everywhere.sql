-- Starter apps were installed only at pairing, so a tablet paired before an app became a starter never got it. From
-- here on the publish adds a new starter to every active tablet; this one-time pass does the same for the starters
-- that already exist, so no active tablet is missing one.
INSERT INTO device_app (family_id, device_id, app_id)
SELECT d.family_id, d.id, a.id FROM device d CROSS JOIN app a WHERE a.starter AND d.state = 'active'
ON CONFLICT DO NOTHING;
