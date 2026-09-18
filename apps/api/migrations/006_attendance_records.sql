CREATE TABLE IF NOT EXISTS attendance_records (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_date date NOT NULL,
  start_time time NOT NULL,
  status text NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, member_id, session_date, start_time)
);
