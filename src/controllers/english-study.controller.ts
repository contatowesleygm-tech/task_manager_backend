import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';

const sessionStatuses = ['planejado', 'concluido', 'cancelado'] as const;
const dateSchema = z.string().date();
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
  message: 'Use o formato HH:MM.',
});

const sessionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  topic: z.string().trim().max(100).nullable().optional(),
  study_date: dateSchema,
  study_time: timeSchema.nullable().optional(),
  duration_minutes: z.number().int().min(1).max(1440).default(30),
  status: z.enum(sessionStatuses).default('planejado'),
  material_url: z.string().trim().url().max(2048).nullable().optional(),
  content: z.string().trim().max(50000).nullable().optional(),
});

const updateSessionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  topic: z.string().trim().max(100).nullable().optional(),
  study_date: dateSchema.optional(),
  study_time: timeSchema.nullable().optional(),
  duration_minutes: z.number().int().min(1).max(1440).optional(),
  status: z.enum(sessionStatuses).optional(),
  material_url: z.string().trim().url().max(2048).nullable().optional(),
  content: z.string().trim().max(50000).nullable().optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'Informe ao menos um campo para atualizar.',
});

const sessionListSchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  status: z.enum(sessionStatuses).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).refine(({ from, to }) =>
  !from || !to || new Date(`${from}T00:00:00Z`) <= new Date(`${to}T00:00:00Z`), {
  message: '"from" deve ser anterior ou igual a "to".',
  path: ['from'],
}).refine(({ from, to }) =>
  !from || !to || (new Date(`${to}T00:00:00Z`).getTime() -
    new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 <= 366, {
  message: 'O intervalo máximo é de 366 dias.',
  path: ['to'],
});

const summaryQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
}).superRefine(({ from, to }, context) => {
  const today = new Date().toISOString().slice(0, 10);
  const end = to ?? today;
  const defaultStart = new Date(`${to ?? today}T00:00:00Z`);
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 6);
  const start = from ?? defaultStart.toISOString().slice(0, 10);
  const difference = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
    86_400_000;

  if (difference < 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '"from" deve ser anterior ou igual a "to".',
      path: ['from'],
    });
  } else if (difference > 366) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'O intervalo máximo é de 366 dias.',
      path: ['to'],
    });
  }
});

const goalSchema = z.object({
  daily_goal_minutes: z.number().int().min(1).max(1440),
});

function parseId(value: string | string[]): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export async function listEnglishStudySessions(req: Request, res: Response, next: NextFunction) {
  const parsed = sessionListSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Filtros ou paginação inválidos.', details: parsed.error.flatten() });
    return;
  }

  const { from, to, status, page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const filters = [req.user!.id, from ?? null, to ?? null, status ?? null];
  try {
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM public.english_study_sessions
       WHERE user_id = $1
         AND ($2::date IS NULL OR study_date >= $2)
         AND ($3::date IS NULL OR study_date <= $3)
         AND ($4::text IS NULL OR status = $4)`,
      filters
    );
    const result = await pool.query(
      `SELECT id, title, topic, study_date, study_time, duration_minutes, status,
              material_url, content, created_at, updated_at
       FROM public.english_study_sessions
       WHERE user_id = $1
         AND ($2::date IS NULL OR study_date >= $2)
         AND ($3::date IS NULL OR study_date <= $3)
         AND ($4::text IS NULL OR status = $4)
       ORDER BY study_date DESC, study_time DESC NULLS LAST, id DESC
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

export async function createEnglishStudySession(req: Request, res: Response, next: NextFunction) {
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }

  const { title, topic, study_date, study_time, duration_minutes, status, material_url, content } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO public.english_study_sessions
         (user_id, title, topic, study_date, study_time, duration_minutes, status, material_url, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, topic, study_date, study_time, duration_minutes, status,
                 material_url, content, created_at, updated_at`,
      [
        req.user!.id, title, topic ?? null, study_date, study_time ?? null,
        duration_minutes, status, material_url ?? null, content ?? null,
      ]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateEnglishStudySession(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID da sessão inválido.' });
    return;
  }
  const parsed = updateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  try {
    const result = await pool.query(
      `UPDATE public.english_study_sessions
       SET title = COALESCE($3, title),
           topic = CASE WHEN $4::boolean THEN $5::text ELSE topic END,
           study_date = COALESCE($6::date, study_date),
           study_time = CASE WHEN $7::boolean THEN $8::time ELSE study_time END,
           duration_minutes = COALESCE($9, duration_minutes),
           status = COALESCE($10, status),
           material_url = CASE WHEN $11::boolean THEN $12::text ELSE material_url END,
           content = CASE WHEN $13::boolean THEN $14::text ELSE content END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id, title, topic, study_date, study_time, duration_minutes, status,
                 material_url, content, created_at, updated_at`,
      [
        id, req.user!.id, data.title ?? null,
        Object.hasOwn(data, 'topic'), data.topic ?? null, data.study_date ?? null,
        Object.hasOwn(data, 'study_time'), data.study_time ?? null,
        data.duration_minutes ?? null, data.status ?? null,
        Object.hasOwn(data, 'material_url'), data.material_url ?? null,
        Object.hasOwn(data, 'content'), data.content ?? null,
      ]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Sessão de estudo não encontrada.' });
      return;
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function deleteEnglishStudySession(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID da sessão inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      'DELETE FROM public.english_study_sessions WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Sessão de estudo não encontrada.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function getEnglishStudyGoal(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pool.query(
      `SELECT COALESCE(
         (SELECT daily_goal_minutes FROM public.english_study_goals WHERE user_id = $1),
         30
       )::int AS daily_goal_minutes`,
      [req.user!.id]
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateEnglishStudyGoal(req: Request, res: Response, next: NextFunction) {
  const parsed = goalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Meta inválida.', details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO public.english_study_goals (user_id, daily_goal_minutes)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
       SET daily_goal_minutes = EXCLUDED.daily_goal_minutes, updated_at = CURRENT_TIMESTAMP
       RETURNING daily_goal_minutes`,
      [req.user!.id, parsed.data.daily_goal_minutes]
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function getEnglishStudySummary(req: Request, res: Response, next: NextFunction) {
  const parsed = summaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Período inválido.', details: parsed.error.flatten() });
    return;
  }
  const { from, to } = parsed.data;
  try {
    const today = await pool.query(
      `SELECT
         COALESCE((SELECT daily_goal_minutes FROM public.english_study_goals WHERE user_id = $1), 30)::int
           AS daily_goal_minutes,
         COALESCE((
           SELECT SUM(duration_minutes)::int
           FROM public.english_study_sessions
           WHERE user_id = $1 AND status = 'concluido' AND study_date = CURRENT_DATE
         ), 0)::int AS minutes_today`,
      [req.user!.id]
    );
    const daily = await pool.query(
      `WITH bounds AS (
         SELECT COALESCE($2::date, COALESCE($3::date, CURRENT_DATE) - 6) AS from_date,
                COALESCE($3::date, CURRENT_DATE) AS to_date
       ),
       dates AS (
         SELECT day::date AS study_date
         FROM bounds
         CROSS JOIN LATERAL generate_series(
           bounds.from_date::timestamp, bounds.to_date::timestamp, INTERVAL '1 day'
         ) AS days(day)
       ),
       totals AS (
         SELECT study_date, COUNT(*)::int AS sessions,
                SUM(duration_minutes)::int AS total_minutes
         FROM public.english_study_sessions
         WHERE user_id = $1 AND status = 'concluido'
           AND study_date >= (SELECT from_date FROM bounds)
           AND study_date <= (SELECT to_date FROM bounds)
         GROUP BY study_date
       )
       SELECT dates.study_date,
              COALESCE(totals.sessions, 0)::int AS sessions,
              COALESCE(totals.total_minutes, 0)::int AS total_minutes
       FROM dates
       LEFT JOIN totals USING (study_date)
       ORDER BY dates.study_date`,
      [req.user!.id, from ?? null, to ?? null]
    );
    const { daily_goal_minutes, minutes_today } = today.rows[0];
    res.json({
      data: {
        daily_goal_minutes,
        minutes_today,
        minutes_remaining_today: Math.max(0, daily_goal_minutes - minutes_today),
        goal_progress_percent: Math.min(100, Math.round(minutes_today / daily_goal_minutes * 100)),
        daily: daily.rows,
      },
    });
  } catch (error) {
    next(error);
  }
}
