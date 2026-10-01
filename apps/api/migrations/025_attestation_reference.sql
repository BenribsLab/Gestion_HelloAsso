-- Numéro de référence imprimé sur chaque attestation (ex. 2026-0042), pour la retrouver.
CREATE SEQUENCE IF NOT EXISTS member_attestation_number;

ALTER TABLE member_attestations
  ADD COLUMN IF NOT EXISTS reference text;

UPDATE member_attestations
SET reference = to_char(created_at, 'YYYY') || '-' || lpad(nextval('member_attestation_number')::text, 4, '0')
WHERE reference IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS member_attestations_reference_idx
  ON member_attestations (reference);
