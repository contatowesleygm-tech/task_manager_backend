CREATE TABLE IF NOT EXISTS public.financial_liabilities (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  source_asset_id BIGINT UNIQUE REFERENCES public.financial_assets(id) ON DELETE SET NULL,
  name VARCHAR(160) NOT NULL,
  liability_type VARCHAR(30) NOT NULL DEFAULT 'outro'
    CHECK (liability_type IN ('financiamento', 'cartao_credito', 'emprestimo', 'aluguel', 'conta', 'outro')),
  original_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (original_amount >= 0),
  outstanding_balance NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (outstanding_balance >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'BRL' CHECK (currency IN ('BRL', 'USD')),
  monthly_payment NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (monthly_payment >= 0),
  due_date DATE,
  notes VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS financial_liabilities_user_type_idx
  ON public.financial_liabilities (user_id, liability_type, name);

INSERT INTO public.financial_liabilities
  (user_id, source_asset_id, name, liability_type, original_amount, outstanding_balance, currency, notes)
SELECT user_id, id, 'Financiamento - ' || name, 'financiamento', outstanding_debt, outstanding_debt,
       currency, 'Migrado do passivo vinculado ao bem.'
FROM public.financial_assets
WHERE outstanding_debt > 0
ON CONFLICT (source_asset_id) DO NOTHING;

UPDATE public.financial_assets
SET outstanding_debt = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE outstanding_debt > 0
  AND EXISTS (
    SELECT 1 FROM public.financial_liabilities l WHERE l.source_asset_id = financial_assets.id
  );
