CREATE TABLE IF NOT EXISTS public.expenses (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  expense_type VARCHAR(10) NOT NULL CHECK (expense_type IN ('compra', 'fixa')),
  category VARCHAR(60) NOT NULL DEFAULT 'Outros',
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  expense_date DATE,
  due_day SMALLINT CHECK (due_day BETWEEN 1 AND 31),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expense_type <> 'compra' OR expense_date IS NOT NULL),
  CHECK (expense_type <> 'fixa' OR due_day IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS expenses_user_type_idx
  ON public.expenses (user_id, expense_type, category);

CREATE INDEX IF NOT EXISTS expenses_user_date_idx
  ON public.expenses (user_id, expense_date);
