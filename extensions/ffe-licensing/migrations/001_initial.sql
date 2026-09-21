-- Tables propres à l'extension, jamais de modification du noyau (voir member_documents pour le
-- même principe côté extraction ffe-health-documents).

CREATE TABLE IF NOT EXISTS ffe_member_facts (
  member_id uuid PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  -- null = jamais renseigné. Manuel : aucune donnée fiable dans le noyau pour le déduire
  -- automatiquement (pas d'historique d'adhésion par saison).
  known_in_ffe_database boolean,
  known_in_ffe_source text NOT NULL DEFAULT 'manual'
    CHECK (known_in_ffe_source IN ('manual', 'automation-matched', 'automation-created')),
  in_structure_last_5_seasons boolean NOT NULL DEFAULT true,
  ffe_person_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ffe_licenses (
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  season text NOT NULL,
  status text NOT NULL DEFAULT 'not_taken'
    CHECK (status IN ('not_taken', 'in_progress', 'taken', 'failed')),
  taken_at timestamptz,
  matched_ffe_person_id text,
  match_mode text CHECK (match_mode IN ('existing_match', 'new_person')),
  automation_run_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, season)
);

CREATE TABLE IF NOT EXISTS ffe_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  season text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'awaiting_login', 'awaiting_confirmation', 'succeeded', 'failed', 'abandoned')),
  step text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  started_by uuid REFERENCES app_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ffe_automation_runs_member_idx ON ffe_automation_runs (member_id, season);
