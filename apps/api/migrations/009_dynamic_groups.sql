ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_source_check;
ALTER TABLE groups
  ADD CONSTRAINT groups_source_check CHECK (source IN ('manual', 'helloasso', 'dynamic'));

ALTER TABLE member_groups DROP CONSTRAINT IF EXISTS member_groups_source_check;
ALTER TABLE member_groups
  ADD CONSTRAINT member_groups_source_check CHECK (source IN ('manual', 'helloasso', 'dynamic'));

CREATE TABLE IF NOT EXISTS group_dynamic_rules (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  match_value text NOT NULL,
  PRIMARY KEY (group_id, field_key, match_value)
);

CREATE INDEX IF NOT EXISTS group_dynamic_rules_field_idx
  ON group_dynamic_rules (field_key, match_value);
