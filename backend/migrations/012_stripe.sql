-- Stripe subscriptions (S2). A family's Stripe customer, set when its first Checkout completes and reused for the next
-- Checkout and the Customer Portal. One customer per family; the subscription rows live in purchase like the stores'.
ALTER TABLE family ADD COLUMN stripe_customer_id text;
CREATE UNIQUE INDEX family_stripe_customer_idx ON family (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
