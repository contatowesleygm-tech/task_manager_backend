CREATE TABLE IF NOT EXISTS public.daily_route_days (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  route_date DATE NOT NULL,
  vehicle_model VARCHAR(100) NOT NULL,
  vehicle_type VARCHAR(10) NOT NULL CHECK (vehicle_type IN ('carro', 'moto')),
  selected_fuel VARCHAR(10) NOT NULL CHECK (selected_fuel IN ('gasolina', 'alcool')),
  fuel_prices JSONB NOT NULL,
  consumption_km_per_l JSONB NOT NULL,
  legs JSONB NOT NULL,
  total_distance_km NUMERIC(12, 2) NOT NULL CHECK (total_distance_km > 0),
  total_fuel_liters NUMERIC(12, 3),
  total_fuel_cost NUMERIC(14, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, route_date)
);

CREATE INDEX IF NOT EXISTS daily_route_days_user_date_idx
  ON public.daily_route_days (user_id, route_date DESC);
