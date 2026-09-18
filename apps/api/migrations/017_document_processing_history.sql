ALTER TABLE member_documents
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS last_exported_hash text,
  ADD COLUMN IF NOT EXISTS last_exported_at timestamptz,
  ADD COLUMN IF NOT EXISTS analysis_version integer NOT NULL DEFAULT 0;

UPDATE member_documents
SET content_hash = analyzed_hash,
    last_exported_hash = analyzed_hash,
    last_exported_at = analyzed_at
WHERE analyzed_hash IS NOT NULL
  AND content_hash IS NULL;
