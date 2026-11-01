ALTER TABLE public.dividend_holdings
  ADD COLUMN IF NOT EXISTS average_price NUMERIC(14, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_price NUMERIC(14, 6);

ALTER TABLE public.dividend_holdings
  DROP CONSTRAINT IF EXISTS dividend_holdings_prices_check;

ALTER TABLE public.dividend_holdings
  ADD CONSTRAINT dividend_holdings_prices_check
  CHECK (average_price >= 0 AND (current_price IS NULL OR current_price >= 0));
