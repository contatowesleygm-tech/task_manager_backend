ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'medium';

ALTER TABLE tasks
  ALTER COLUMN priority SET DEFAULT 'medium';

UPDATE tasks
SET priority = 'medium'
WHERE priority IS NULL
   OR priority NOT IN ('low', 'medium', 'high');

ALTER TABLE tasks
  ALTER COLUMN priority SET NOT NULL;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_priority_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_priority_check
  CHECK (priority IN ('low', 'medium', 'high'));

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_frequencia_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_frequencia_check
  CHECK (frequencia IN ('dia', 'diaria', 'semana', 'semanal', 'mes', 'mensal'));
