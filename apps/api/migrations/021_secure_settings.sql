CREATE TABLE IF NOT EXISTS secure_settings (
  namespace text PRIMARY KEY,
  public_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_value text,
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS secure_settings_updated_idx
  ON secure_settings (updated_at DESC);
