UPDATE helloasso_fields
SET document_role = 'health', updated_at = now()
WHERE field_key = (
  SELECT field_key
  FROM helloasso_fields
  WHERE selected = true
    AND field_type = 'File'
    AND (
      label ILIKE '%certificat%'
      OR label ILIKE '%attestation%'
      OR label ILIKE '%questionnaire%santé%'
      OR label ILIKE '%questionnaire%sante%'
    )
  ORDER BY label
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1 FROM helloasso_fields WHERE document_role = 'health'
);
