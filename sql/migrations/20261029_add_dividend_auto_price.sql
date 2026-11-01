ALTER TABLE public.dividend_holdings
  ADD COLUMN IF NOT EXISTS auto_price BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS price_updated_at TIMESTAMPTZ;

-- Preços já digitados manualmente continuam como estão.
UPDATE public.dividend_holdings SET auto_price = FALSE WHERE current_price IS NOT NULL;
