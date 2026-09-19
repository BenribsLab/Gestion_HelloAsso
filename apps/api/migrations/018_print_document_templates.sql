CREATE TABLE IF NOT EXISTS print_document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  document_title text NOT NULL,
  content_html text NOT NULL,
  output_mode text NOT NULL DEFAULT 'combined'
    CHECK (output_mode IN ('individual', 'combined')),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS print_document_templates_name_unique_idx
  ON print_document_templates (lower(name));
