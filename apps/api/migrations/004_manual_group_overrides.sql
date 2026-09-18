CREATE TABLE IF NOT EXISTS member_group_exclusions (
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, group_id)
);
