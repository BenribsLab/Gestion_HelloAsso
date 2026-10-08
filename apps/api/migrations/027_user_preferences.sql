-- Préférences d'affichage propres à chaque compte (raccourcis de la barre du bas sur mobile…).
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
