CREATE TABLE IF NOT EXISTS public.financial_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  institution VARCHAR(120) NOT NULL,
  account_name VARCHAR(120) NOT NULL,
  account_type VARCHAR(20) NOT NULL DEFAULT 'conta_corrente'
    CHECK (account_type IN ('conta_corrente', 'poupanca', 'investimento', 'dinheiro', 'outro')),
  balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
  notes VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS financial_accounts_user_institution_idx
  ON public.financial_accounts (user_id, institution, account_name);
