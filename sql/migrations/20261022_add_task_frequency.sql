ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS frequencia VARCHAR(20);

ALTER TABLE tasks
  ALTER COLUMN frequencia DROP DEFAULT;

ALTER TABLE tasks
  ALTER COLUMN frequencia TYPE VARCHAR(20)
  USING CASE
    WHEN frequencia::text IN ('dia', 'diaria', 'semana', 'semanal', 'mes', 'mensal')
      THEN frequencia::text
    ELSE 'diaria'
  END;

ALTER TABLE tasks
  ALTER COLUMN frequencia SET DEFAULT 'diaria';

UPDATE tasks
SET frequencia = 'diaria'
WHERE frequencia IS NULL
   OR frequencia NOT IN ('diaria', 'semanal', 'mensal');

ALTER TABLE tasks
  ALTER COLUMN frequencia SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_frequencia_check;
  ALTER TABLE tasks
    ADD CONSTRAINT tasks_frequencia_check
    CHECK (frequencia IN ('dia', 'diaria', 'semana', 'semanal', 'mes', 'mensal'));
END;
$$;
