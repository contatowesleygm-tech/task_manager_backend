CREATE TABLE IF NOT EXISTS public.activity_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL CHECK (event_type IN (
    'checklist_item_completed',
    'goal_step_completed',
    'goal_completed',
    'objective_step_completed',
    'objective_completed'
  )),
  entity_id BIGINT,
  title VARCHAR(200) NOT NULL,
  message VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS activity_events_user_created_idx
  ON public.activity_events (user_id, created_at DESC, id DESC);
