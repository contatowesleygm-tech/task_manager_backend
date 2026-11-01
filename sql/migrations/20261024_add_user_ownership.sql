ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE public.objectives
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE public.schedule_events
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES public.app_users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON public.tasks(user_id);
CREATE INDEX IF NOT EXISTS objectives_user_id_idx ON public.objectives(user_id);
CREATE INDEX IF NOT EXISTS schedule_events_user_id_idx ON public.schedule_events(user_id);
