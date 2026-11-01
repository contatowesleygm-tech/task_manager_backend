CREATE TABLE IF NOT EXISTS public.financial_assets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  asset_type VARCHAR(20) NOT NULL CHECK (asset_type IN ('carro', 'moto', 'imovel', 'outro')),
  estimated_value NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  outstanding_debt NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (outstanding_debt >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'BRL' CHECK (currency IN ('BRL', 'USD')),
  ownership_status VARCHAR(30) NOT NULL DEFAULT 'proprio'
    CHECK (ownership_status IN ('proprio', 'financiado', 'alugado', 'alugado_para_terceiros', 'outro')),
  monthly_rent NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (monthly_rent >= 0),
  include_in_patrimony BOOLEAN NOT NULL DEFAULT TRUE,
  notes VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS financial_assets_user_type_idx
  ON public.financial_assets (user_id, asset_type, name);
