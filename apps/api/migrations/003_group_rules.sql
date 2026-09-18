ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'helloasso')),
  ADD COLUMN IF NOT EXISTS source_key text;

ALTER TABLE member_groups
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'helloasso'));

CREATE TABLE IF NOT EXISTS helloasso_group_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS helloasso_group_rules (
  group_definition_id uuid NOT NULL
    REFERENCES helloasso_group_definitions(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  match_value text NOT NULL,
  PRIMARY KEY (group_definition_id, field_key, match_value)
);
