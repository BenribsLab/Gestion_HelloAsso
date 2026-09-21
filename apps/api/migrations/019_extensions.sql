CREATE TABLE IF NOT EXISTS installed_extensions (
  id text PRIMARY KEY,
  version text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'bundled'
    CHECK (source IN ('bundled', 'local', 'central')),
  manifest_json jsonb NOT NULL,
  package_hash text,
  signature_status text NOT NULL DEFAULT 'bundled'
    CHECK (signature_status IN ('bundled', 'verified', 'unsigned', 'invalid')),
  entitlement_key text,
  license_status text NOT NULL DEFAULT 'local'
    CHECK (license_status IN ('local', 'valid', 'grace', 'expired', 'unavailable')),
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  error_message text
);

CREATE TABLE IF NOT EXISTS extension_migrations (
  extension_id text NOT NULL REFERENCES installed_extensions(id) ON DELETE CASCADE,
  filename text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (extension_id, filename)
);

