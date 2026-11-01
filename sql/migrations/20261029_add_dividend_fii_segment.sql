ALTER TABLE public.dividend_holdings
  ADD COLUMN IF NOT EXISTS fii_segment VARCHAR(10);

ALTER TABLE public.dividend_holdings
  DROP CONSTRAINT IF EXISTS dividend_holdings_fii_segment_check;

ALTER TABLE public.dividend_holdings
  ADD CONSTRAINT dividend_holdings_fii_segment_check
  CHECK (fii_segment IS NULL OR fii_segment IN ('papel', 'tijolo', 'hibrido'));
