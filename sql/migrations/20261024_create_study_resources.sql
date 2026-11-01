CREATE TABLE IF NOT EXISTS public.study_resources (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  area VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL
    CHECK (type IN ('link', 'texto', 'documento', 'video', 'curso', 'livro', 'artigo', 'imagem', 'outro')),
  url VARCHAR(2048),
  content TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (url IS NOT NULL OR content IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS study_resources_user_area_idx
  ON public.study_resources (user_id, area, type);

CREATE INDEX IF NOT EXISTS study_resources_tags_idx
  ON public.study_resources USING GIN (tags);
