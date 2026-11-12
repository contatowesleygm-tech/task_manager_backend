ALTER TABLE public.dividend_holdings
  ADD COLUMN IF NOT EXISTS rate_type TEXT NOT NULL DEFAULT 'cdi'
    CHECK (rate_type IN ('cdi', 'prefixado')),
  ADD COLUMN IF NOT EXISTS fixed_rate_percent NUMERIC(8, 3)
    CHECK (fixed_rate_percent >= 0),
  ADD COLUMN IF NOT EXISTS maturity_date DATE;
