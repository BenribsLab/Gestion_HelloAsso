CREATE TABLE IF NOT EXISTS extension_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id text,
  version text,
  outcome text NOT NULL CHECK (outcome IN ('installed', 'failed', 'rolled_back')),
  source text NOT NULL CHECK (source IN ('signed', 'developer')),
  package_hash text,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS extension_installations_created_idx
  ON extension_installations (created_at DESC);
