ALTER TABLE members
  ADD COLUMN IF NOT EXISTS local_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS members_local_overrides_idx
  ON members USING gin (local_overrides);
