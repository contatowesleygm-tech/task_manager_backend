ALTER TABLE public.activity_events
  DROP CONSTRAINT IF EXISTS activity_events_event_type_check;

ALTER TABLE public.activity_events
  ADD CONSTRAINT activity_events_event_type_check CHECK (event_type IN (
    'checklist_item_completed',
    'goal_step_completed',
    'goal_completed',
    'objective_step_completed',
    'objective_completed'
  ));
