ALTER TABLE public.dividend_holdings
  ALTER COLUMN ticker TYPE VARCHAR(40),
  ALTER COLUMN asset_type TYPE VARCHAR(32);

ALTER TABLE public.dividend_holdings
  DROP CONSTRAINT IF EXISTS dividend_holdings_asset_type_check;

ALTER TABLE public.dividend_holdings
  ADD CONSTRAINT dividend_holdings_asset_type_check
  CHECK (asset_type IN (
    'fii', 'fiagro', 'acao', 'bdr', 'etf', 'fundo', 'tesouro', 'cdb',
    'lci_lca', 'debenture', 'previdencia', 'cripto', 'acao_us', 'renda_fixa', 'outro'
  ));
