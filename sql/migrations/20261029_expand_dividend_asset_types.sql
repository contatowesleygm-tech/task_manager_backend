ALTER TABLE public.dividend_holdings
  DROP CONSTRAINT IF EXISTS dividend_holdings_asset_type_check;

ALTER TABLE public.dividend_holdings
  ADD CONSTRAINT dividend_holdings_asset_type_check
  CHECK (asset_type IN ('fii', 'fiagro', 'acao', 'bdr', 'etf', 'renda_fixa', 'outro'));
