ALTER TABLE public.dividend_holdings
  ADD COLUMN IF NOT EXISTS cdi_percent NUMERIC(8, 2) CHECK (cdi_percent >= 0),
  ADD COLUMN IF NOT EXISTS applied_amount NUMERIC(14, 2) CHECK (applied_amount >= 0),
  ADD COLUMN IF NOT EXISTS investment_date DATE;
