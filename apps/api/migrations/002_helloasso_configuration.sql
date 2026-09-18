ALTER TABLE members
  ADD COLUMN IF NOT EXISTS profile_data jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS helloasso_campaigns (
  form_slug text PRIMARY KEY,
  title text NOT NULL,
  form_type text NOT NULL DEFAULT 'Membership',
  state text NOT NULL,
  start_date timestamptz,
  end_date timestamptz,
  selected boolean NOT NULL DEFAULT false,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS helloasso_fields (
  field_key text PRIMARY KEY,
  label text NOT NULL,
  field_type text NOT NULL,
  selected boolean NOT NULL DEFAULT false,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS helloasso_campaign_fields (
  form_slug text NOT NULL REFERENCES helloasso_campaigns(form_slug) ON DELETE CASCADE,
  source_field_id text NOT NULL,
  field_key text NOT NULL REFERENCES helloasso_fields(field_key) ON DELETE CASCADE,
  PRIMARY KEY (form_slug, source_field_id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
