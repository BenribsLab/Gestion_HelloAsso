ALTER TABLE members
  ADD COLUMN IF NOT EXISTS locally_deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS members_visible_idx
  ON members (status, last_name, first_name)
  WHERE locally_deleted_at IS NULL;

ALTER TABLE helloasso_fields
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'helloasso'
  CHECK (source IN ('helloasso', 'local'));
