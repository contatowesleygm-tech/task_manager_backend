CREATE TABLE IF NOT EXISTS public.subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  plan VARCHAR(16) NOT NULL CHECK (plan IN ('monthly', 'annual')),
  status VARCHAR(32) NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'active', 'past_due', 'cancelled', 'expired')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_open_per_user_idx
  ON public.subscriptions (user_id)
  WHERE status IN ('pending_payment', 'active', 'past_due');

CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON public.subscriptions(user_id);

CREATE TABLE IF NOT EXISTS public.payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  subscription_id BIGINT NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  plan VARCHAR(16) NOT NULL CHECK (plan IN ('monthly', 'annual')),
  payment_method VARCHAR(16) NOT NULL CHECK (payment_method IN ('pix', 'card')),
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'awaiting_payment', 'paid', 'failed', 'cancelled')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'BRL',
  card_brand VARCHAR(32),
  card_last4 CHAR(4),
  card_holder_name VARCHAR(120),
  gateway VARCHAR(32),
  gateway_payment_id VARCHAR(120),
  pix_copy_paste TEXT,
  pix_qr_code_base64 TEXT,
  pix_expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS payments_user_id_idx ON public.payments(user_id);
CREATE INDEX IF NOT EXISTS payments_subscription_id_idx ON public.payments(subscription_id);
CREATE INDEX IF NOT EXISTS payments_status_idx ON public.payments(status);
