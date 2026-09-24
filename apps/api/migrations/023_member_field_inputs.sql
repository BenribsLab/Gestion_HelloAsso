ALTER TABLE helloasso_fields
  ADD COLUMN IF NOT EXISTS input_mode text NOT NULL DEFAULT 'auto'
    CHECK (input_mode IN ('auto', 'text', 'select')),
  ADD COLUMN IF NOT EXISTS choice_options jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS module_data jsonb NOT NULL DEFAULT '{}'::jsonb;

