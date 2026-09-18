CREATE TABLE IF NOT EXISTS email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  body text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('all', 'groups', 'single')),
  target_group_id uuid REFERENCES groups(id) ON DELETE SET NULL,
  target_label text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'partial', 'failed')),
  recipients_count integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  email text NOT NULL,
  member_names text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  error_message text,
  sent_at timestamptz,
  UNIQUE (message_id, email)
);

CREATE INDEX IF NOT EXISTS email_messages_created_idx ON email_messages (created_at DESC);
