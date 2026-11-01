ALTER TABLE public.study_resources
  DROP CONSTRAINT IF EXISTS study_resources_type_check;

ALTER TABLE public.study_resources
  ADD CONSTRAINT study_resources_type_check
  CHECK (type IN ('link', 'texto', 'documento', 'video', 'curso', 'livro', 'artigo', 'imagem', 'outro'));
