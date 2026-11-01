CREATE TABLE IF NOT EXISTS public.english_study_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  topic VARCHAR(100),
  study_date DATE NOT NULL,
  study_time TIME,
  duration_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (duration_minutes BETWEEN 1 AND 1440),
  status VARCHAR(20) NOT NULL DEFAULT 'planejado'
    CHECK (status IN ('planejado', 'concluido', 'cancelado')),
  material_url VARCHAR(2048),
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS english_study_sessions_user_date_idx
  ON public.english_study_sessions (user_id, study_date, status);

CREATE TABLE IF NOT EXISTS public.english_study_goals (
  user_id BIGINT PRIMARY KEY REFERENCES public.app_users(id) ON DELETE CASCADE,
  daily_goal_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (daily_goal_minutes BETWEEN 1 AND 1440),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
