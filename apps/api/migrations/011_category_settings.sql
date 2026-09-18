CREATE TABLE IF NOT EXISTS fencing_category_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  rollover_month smallint NOT NULL DEFAULT 9 CHECK (rollover_month BETWEEN 1 AND 12),
  rollover_day smallint NOT NULL DEFAULT 1 CHECK (rollover_day BETWEEN 1 AND 31),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO fencing_category_settings (singleton, rollover_month, rollover_day)
VALUES (true, 9, 1)
ON CONFLICT (singleton) DO NOTHING;
