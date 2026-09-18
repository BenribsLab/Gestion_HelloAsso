ALTER TABLE helloasso_fields
  ADD COLUMN IF NOT EXISTS document_role text
  CHECK (document_role IS NULL OR document_role IN ('health'));

CREATE TABLE IF NOT EXISTS member_documents (
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  field_key text NOT NULL REFERENCES helloasso_fields(field_key) ON DELETE CASCADE,
  helloasso_url text,
  helloasso_name text,
  helloasso_media_type text,
  helloasso_size_bytes integer,
  local_content bytea,
  local_name text,
  local_media_type text,
  local_size_bytes integer,
  classification text NOT NULL DEFAULT 'unknown'
    CHECK (classification IN ('certificate', 'attestation', 'unknown')),
  classification_source text NOT NULL DEFAULT 'automatic'
    CHECK (classification_source IN ('automatic', 'manual')),
  analyzed_hash text,
  analyzed_at timestamptz,
  local_uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, field_key)
);

CREATE INDEX IF NOT EXISTS member_documents_field_idx
  ON member_documents (field_key, classification);

CREATE TABLE IF NOT EXISTS document_access_log (
  id bigserial PRIMARY KEY,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  field_key text,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('view', 'download', 'upload', 'revert', 'classify', 'export')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_access_log_created_idx
  ON document_access_log (created_at DESC);
