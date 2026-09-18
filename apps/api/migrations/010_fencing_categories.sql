CREATE TABLE IF NOT EXISTS fencing_category_seasons (
  season_start_year integer PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fencing_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_start_year integer NOT NULL
    REFERENCES fencing_category_seasons(season_start_year) ON DELETE CASCADE,
  name text NOT NULL,
  birth_year_from integer NOT NULL CHECK (birth_year_from BETWEEN 1900 AND 2200),
  birth_year_to integer NOT NULL CHECK (birth_year_to BETWEEN 1900 AND 2200),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (birth_year_from <= birth_year_to),
  UNIQUE (season_start_year, name)
);

CREATE INDEX IF NOT EXISTS fencing_categories_season_years_idx
  ON fencing_categories (season_start_year, birth_year_from, birth_year_to);
