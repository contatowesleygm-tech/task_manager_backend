import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  date: z.string().date().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  event_type: z.enum([
    'checklist_item_completed',
    'goal_step_completed',
    'goal_completed',
    'objective_step_completed',
    'objective_completed',
  ]).optional(),
}).superRefine((data, context) => {
  if (data.date && (data.from || data.to)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['date'], message: 'Use date ou from/to, não os dois.' });
  }
  if (data.from && data.to && data.from > data.to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'from deve ser anterior ou igual a to.' });
  }
});

export async function listActivityEvents(req: Request, res: Response, next: NextFunction) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Parâmetros de paginação inválidos.', details: parsed.error.flatten() });
    return;
  }

  const { page, limit, date, from, to, event_type: eventType } = parsed.data;
  const filters = [req.user!.id, date ?? from ?? null, date ?? to ?? null, eventType ?? null];
  try {
    const [countResult, result] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM public.activity_events
         WHERE user_id = $1
           AND ($2::date IS NULL OR created_at >= $2::date)
           AND ($3::date IS NULL OR created_at < $3::date + INTERVAL '1 day')
           AND ($4::varchar IS NULL OR event_type = $4)`,
        filters
      ),
      pool.query(
        `SELECT id, event_type, entity_id, title, message, created_at
         FROM public.activity_events
         WHERE user_id = $1
           AND ($2::date IS NULL OR created_at >= $2::date)
           AND ($3::date IS NULL OR created_at < $3::date + INTERVAL '1 day')
           AND ($4::varchar IS NULL OR event_type = $4)
         ORDER BY created_at DESC, id DESC
         LIMIT $5 OFFSET $6`,
        [...filters, limit, (page - 1) * limit]
      ),
    ]);
    const total = countResult.rows[0].total as number;
    res.json({
      data: result.rows,
      filters: {
        date: date ?? null,
        from: from ?? null,
        to: to ?? null,
        event_type: eventType ?? null,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getActivityEvent(req: Request, res: Response, next: NextFunction) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'ID da atividade inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT id, event_type, entity_id, title, message, created_at
       FROM public.activity_events
       WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Atividade não encontrada.' });
      return;
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function getActivitySummary(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS events_count,
              COUNT(*) FILTER (WHERE event_type = 'checklist_item_completed')::int AS checks_completed,
              COUNT(*) FILTER (WHERE event_type = 'goal_step_completed')::int AS goal_steps_completed,
              COUNT(*) FILTER (WHERE event_type = 'objective_step_completed')::int AS objective_steps_completed,
              COUNT(*) FILTER (WHERE event_type IN ('goal_completed', 'objective_completed'))::int AS goals_completed,
              MAX(created_at) AS last_activity_at
       FROM public.activity_events
       WHERE user_id = $1`,
      [req.user!.id]
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}
