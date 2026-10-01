-- Identité visuelle du club, apposée sur les attestations : logo, signature, tampon.
CREATE TABLE IF NOT EXISTS club_assets (
  kind text PRIMARY KEY CHECK (kind IN ('logo', 'signature', 'stamp')),
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg')),
  content bytea NOT NULL,
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Trace des attestations de cotisation produites (qui, pour qui, comment).
CREATE TABLE IF NOT EXISTS member_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  issued_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  delivery text NOT NULL CHECK (delivery IN ('download', 'email')),
  recipient_email text,
  season text NOT NULL,
  amount_cents integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_attestations_member_idx
  ON member_attestations (member_id, created_at DESC);
