-- Les tables group_training_schedules et attendance_records viennent encore des migrations
-- historiques du noyau (005, 006) : leur rapatriement ici attend qu'on sache le faire sans
-- risque de double application sur une base existante.

CREATE INDEX IF NOT EXISTS attendance_records_period_idx
  ON attendance_records (group_id, session_date);
