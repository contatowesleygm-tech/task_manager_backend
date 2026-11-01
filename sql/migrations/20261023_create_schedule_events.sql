CREATE TABLE IF NOT EXISTS public.schedule_events (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  type VARCHAR(20) NOT NULL
    CHECK (type IN ('lembrete', 'atividade', 'aniversario')),
  event_date DATE NOT NULL,
  event_time TIME,
  reminder_at TIMESTAMPTZ,
  repeat_yearly BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'concluido', 'cancelado')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS schedule_events_date_idx
  ON public.schedule_events (event_date, event_time);

CREATE INDEX IF NOT EXISTS schedule_events_repeat_date_idx
  ON public.schedule_events (repeat_yearly, event_date);
