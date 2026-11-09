ALTER TABLE public.dividend_holdings
  ADD COLUMN IF NOT EXISTS income_tax_exempt BOOLEAN NOT NULL DEFAULT FALSE;
