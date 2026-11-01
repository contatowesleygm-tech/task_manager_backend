CREATE TABLE IF NOT EXISTS public.dividend_holdings (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  ticker VARCHAR(20) NOT NULL,
  name VARCHAR(160),
  asset_type VARCHAR(20) NOT NULL DEFAULT 'fii'
    CHECK (asset_type IN ('fii', 'fiagro', 'acao', 'bdr', 'etf', 'renda_fixa', 'outro')),
  quantity NUMERIC(18, 6) NOT NULL CHECK (quantity > 0),
  dividend_per_share NUMERIC(14, 6) NOT NULL DEFAULT 0 CHECK (dividend_per_share >= 0),
  frequency VARCHAR(12) NOT NULL DEFAULT 'mensal'
    CHECK (frequency IN ('mensal', 'trimestral', 'semestral', 'anual')),
  reference_month SMALLINT NOT NULL DEFAULT 1 CHECK (reference_month BETWEEN 1 AND 12),
  payment_day SMALLINT NOT NULL DEFAULT 15 CHECK (payment_day BETWEEN 1 AND 31),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS dividend_holdings_user_ticker_idx
  ON public.dividend_holdings (user_id, ticker);
