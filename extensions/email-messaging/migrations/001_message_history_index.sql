-- Les tables email_messages et email_deliveries viennent encore de la migration 012 du noyau ;
-- leur rapatriement ici attend qu'on sache le faire sans double application.

CREATE INDEX IF NOT EXISTS email_messages_history_idx
  ON email_messages (created_at DESC);
