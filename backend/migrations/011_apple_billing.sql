-- Apple subscriptions. The iPad app passes the family's appAccountToken with every purchase, so Apple's server
-- notifications name the family without any lookup by person. The token is a random UUID, one per family, and
-- carries nothing about the family itself.
ALTER TABLE family ADD COLUMN app_account_token uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX family_app_account_token_idx ON family (app_account_token);
