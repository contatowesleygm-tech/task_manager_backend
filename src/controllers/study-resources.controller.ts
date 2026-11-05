import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';

const resourceTypes = ['link', 'texto', 'documento', 'video', 'curso', 'livro', 'artigo', 'imagem', 'outro'] as const;
const optionalTextFilter = z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).max(200).optional()
);
const optionalAreaFilter = z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).max(100).optional()
);
const optionalTypeFilter = z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.enum(resourceTypes).optional()
);

const createResourceSchema = z.object({
  title: z.string().trim().min(1).max(200),
  area: z.string().trim().min(1).max(100),
  type: z.enum(resourceTypes),
  url: z.string().trim().url().max(2048).nullable().optional(),
  content: z.string().trim().max(50000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]),
}).refine(data => Boolean(data.url || data.content), {
  message: 'Informe uma URL ou um texto/conteúdo.',
  path: ['content'],
}).refine(data => data.type !== 'imagem' || Boolean(data.url), {
  message: 'Informe a URL da imagem.',
  path: ['url'],
});

const updateResourceSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  area: z.string().trim().min(1).max(100).optional(),
  type: z.enum(resourceTypes).optional(),
  url: z.string().trim().url().max(2048).nullable().optional(),
  content: z.string().trim().max(50000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'Informe ao menos um campo para atualizar.',
});

const listQuerySchema = z.object({
  area: optionalAreaFilter,
  type: optionalTypeFilter,
  search: optionalTextFilter,
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function parseId(value: string | string[]): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export async function listStudyResources(req: Request, res: Response, next: NextFunction) {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Filtros ou paginação inválidos.', details: parsed.error.flatten() });
    return;
  }

  const { area, type, search, page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const filters = [req.user!.id, area ?? null, type ?? null, search ? `%${search}%` : null];
  try {
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM public.study_resources
       WHERE user_id = $1
         AND ($2::text IS NULL OR area = $2)
         AND ($3::text IS NULL OR type = $3)
         AND ($4::text IS NULL OR title ILIKE $4 OR content ILIKE $4 OR url ILIKE $4)`,
      filters
    );
    const result = await pool.query(
      `SELECT id, title, area, type, url, content, tags, created_at, updated_at
       FROM public.study_resources
       WHERE user_id = $1
         AND ($2::text IS NULL OR area = $2)
         AND ($3::text IS NULL OR type = $3)
         AND ($4::text IS NULL OR title ILIKE $4 OR content ILIKE $4 OR url ILIKE $4)
       ORDER BY area, title, id DESC
       LIMIT $5 OFFSET $6`,
      [...filters, limit, offset]
    );
    const total = Number(count.rows[0].total);
    res.json({
      data: result.rows,
      pagination: {
        page, limit, total, totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total, hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function listStudyAreas(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pool.query(
      `SELECT area, COUNT(*)::int AS resource_count
       FROM public.study_resources
       WHERE user_id = $1
       GROUP BY area
       ORDER BY area`,
      [req.user!.id]
    );
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
}

export async function getStudyResource(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do material inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT id, title, area, type, url, content, tags, created_at, updated_at
       FROM public.study_resources WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Material de estudo não encontrado.' });
      return;
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function createStudyResource(req: Request, res: Response, next: NextFunction) {
  const parsed = createResourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }
  const { title, area, type, url, content, tags } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO public.study_resources (user_id, title, area, type, url, content, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, title, area, type, url, content, tags, created_at, updated_at`,
      [req.user!.id, title, area, type, url ?? null, content ?? null, tags]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateStudyResource(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do material inválido.' });
    return;
  }
  const parsed = updateResourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  try {
    const current = await pool.query(
      'SELECT url, content FROM public.study_resources WHERE id = $1 AND user_id = $2',
      [id, req.user!.id]
    );
    if (!current.rowCount) {
      res.status(404).json({ error: 'Material de estudo não encontrado.' });
      return;
    }
    const nextUrl = Object.hasOwn(data, 'url') ? data.url : current.rows[0].url;
    const nextContent = Object.hasOwn(data, 'content') ? data.content : current.rows[0].content;
    const nextType = data.type ?? current.rows[0].type;
    if (!nextUrl && !nextContent) {
      res.status(400).json({ error: 'O material precisa manter uma URL ou um texto/conteúdo.' });
      return;
    }
    if (nextType === 'imagem' && !nextUrl) {
      res.status(400).json({ error: 'Informe a URL da imagem.' });
      return;
    }

    const result = await pool.query(
      `UPDATE public.study_resources
       SET title = COALESCE($3, title),
           area = COALESCE($4, area),
           type = COALESCE($5, type),
           url = CASE WHEN $6::boolean THEN $7::text ELSE url END,
           content = CASE WHEN $8::boolean THEN $9::text ELSE content END,
           tags = COALESCE($10::text[], tags),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id, title, area, type, url, content, tags, created_at, updated_at`,
      [
        id, req.user!.id, data.title ?? null, data.area ?? null, data.type ?? null,
        Object.hasOwn(data, 'url'), data.url ?? null,
        Object.hasOwn(data, 'content'), data.content ?? null, data.tags ?? null,
      ]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Material de estudo não encontrado.' });
      return;
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function deleteStudyResource(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do material inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      'DELETE FROM public.study_resources WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Material de estudo não encontrado.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
