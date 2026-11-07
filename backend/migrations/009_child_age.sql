-- The child's age, kept as a birth month so it stays right; the starting level of each subject is derived from it
-- (two years below the child's age) unless the parent chooses otherwise. levels: { reading, math, science, logic,
-- art, music } on the grade scale -1 (pre-K), 0 (K), 1 to 8.
ALTER TABLE child ADD COLUMN birth_month text;
