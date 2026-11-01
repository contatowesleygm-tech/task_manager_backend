ALTER TABLE public.financial_accounts
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'BRL';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'financial_accounts_currency_check'
      AND conrelid = 'public.financial_accounts'::regclass
  ) THEN
    ALTER TABLE public.financial_accounts
      ADD CONSTRAINT financial_accounts_currency_check CHECK (currency IN ('BRL', 'USD'));
  END IF;
END
$$;
