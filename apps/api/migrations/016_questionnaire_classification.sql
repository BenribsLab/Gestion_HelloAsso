ALTER TABLE member_documents
  DROP CONSTRAINT IF EXISTS member_documents_classification_check;

ALTER TABLE member_documents
  ADD CONSTRAINT member_documents_classification_check
  CHECK (classification IN ('certificate', 'attestation', 'questionnaire', 'unknown'));

UPDATE member_documents
SET classification = 'unknown', analyzed_hash = NULL, analyzed_at = NULL, updated_at = now()
WHERE classification_source = 'automatic';
