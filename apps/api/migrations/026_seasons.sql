-- Saisons sportives. Une saison n'existe que lorsqu'elle est créée par le club ; elle
-- regroupe ses campagnes HelloAsso et les inscriptions de ses adhérents.
CREATE TABLE IF NOT EXISTS seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on > starts_on)
);

-- Reprise de l'existant : la saison en cours (bascule au 1er septembre, heure de Paris).
INSERT INTO seasons (label, starts_on, ends_on)
SELECT start_year || '-' || (start_year + 1), make_date(start_year, 9, 1), make_date(start_year + 1, 8, 31)
FROM (
  SELECT CASE
    WHEN extract(month FROM now() AT TIME ZONE 'Europe/Paris') >= 9
      THEN extract(year FROM now() AT TIME ZONE 'Europe/Paris')::int
    ELSE extract(year FROM now() AT TIME ZONE 'Europe/Paris')::int - 1
  END AS start_year
) current_season
ON CONFLICT (label) DO NOTHING;

-- Une campagne HelloAsso appartient à une saison. `selected` reste vrai pour toute campagne
-- rattachée à une saison : les champs proposés restent communs à toutes les saisons.
ALTER TABLE helloasso_campaigns
  ADD COLUMN IF NOT EXISTS season_id uuid REFERENCES seasons(id) ON DELETE SET NULL;

UPDATE helloasso_campaigns
SET season_id = (SELECT id FROM seasons ORDER BY starts_on DESC LIMIT 1)
WHERE selected = true AND season_id IS NULL;

CREATE INDEX IF NOT EXISTS helloasso_campaigns_season_idx ON helloasso_campaigns (season_id);

-- Une ligne `members` est désormais l'inscription d'une personne pour une saison.
-- `person_id` relie les inscriptions successives d'une même personne.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS season_id uuid REFERENCES seasons(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS person_id uuid;

UPDATE members
SET season_id = (SELECT id FROM seasons ORDER BY starts_on DESC LIMIT 1)
WHERE season_id IS NULL;

UPDATE members SET person_id = id WHERE person_id IS NULL;

ALTER TABLE members
  ALTER COLUMN season_id SET NOT NULL,
  ALTER COLUMN person_id SET NOT NULL,
  ALTER COLUMN person_id SET DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS members_season_idx ON members (season_id, last_name, first_name);
CREATE INDEX IF NOT EXISTS members_person_idx ON members (person_id);

-- Date du certificat médical (valable 3 saisons) : saisie à la main sur le document.
ALTER TABLE member_documents
  ADD COLUMN IF NOT EXISTS certificate_date date;

-- Correspondance refaite à la main entre un champ de campagne et un champ choisi (champ
-- renommé ou de type modifié dans HelloAsso d'une saison à l'autre).
ALTER TABLE helloasso_campaign_fields
  ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;
