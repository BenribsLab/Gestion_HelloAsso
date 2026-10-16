-- Mot de passe oublié : liens de réinitialisation à usage unique, valables 30 minutes. Seule
-- l'empreinte (SHA-256) du lien est conservée : une copie de la base ne permet pas de s'en servir.
CREATE TABLE IF NOT EXISTS app_password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_password_resets_user_idx ON app_password_resets (user_id, created_at DESC);
