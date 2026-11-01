import { Request, Response, NextFunction } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../config/database";
import { ensureDailyRecords } from "../services/daily.service";
import { recordActivity } from "../services/activity.service";

const dateSchema = z.string().date();
const historyQuerySchema = z.object({
  date: dateSchema.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
const periodHistoryQuerySchema = z.object({
  date: dateSchema.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

async function getPeriodHistory(
  req: Request,
  res: Response,
  next: NextFunction,
  period: 'week' | 'month'
) {
  const parsed = periodHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Informe uma data válida no formato YYYY-MM-DD',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { date, page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const periodStart = `DATE_TRUNC('${period}', record_date)::date`;

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM (
         SELECT ${periodStart}
         FROM task_daily_records dr
         JOIN task_items ti ON ti.id = dr.task_item_id
         JOIN tasks t ON t.id = ti.task_id AND t.user_id = $2
         WHERE dr.record_date < CURRENT_DATE
           AND (
             $1::date IS NULL
             OR ${periodStart} = DATE_TRUNC('${period}', $1::date)::date
           )
         GROUP BY ${periodStart}
       ) history_periods`,
      [date ?? null, req.user!.id]
    );

    const result = await pool.query(
      `WITH history_periods AS (
         SELECT ${periodStart} AS period_start
         FROM task_daily_records dr
         JOIN task_items ti ON ti.id = dr.task_item_id
         JOIN tasks t ON t.id = ti.task_id AND t.user_id = $4
         WHERE dr.record_date < CURRENT_DATE
           AND (
             $1::date IS NULL
             OR ${periodStart} = DATE_TRUNC('${period}', $1::date)::date
           )
         GROUP BY ${periodStart}
         ORDER BY period_start DESC
         LIMIT $2
         OFFSET $3
       )
       SELECT
         hp.period_start AS start_date,
         (hp.period_start + INTERVAL '1 ${period}' - INTERVAL '1 day')::date AS end_date,
         COUNT(dr.id)::int AS total_items,
         COUNT(dr.id) FILTER (WHERE dr.completed)::int AS completed_items,
         COUNT(dr.id) FILTER (WHERE NOT dr.completed)::int AS pending_items,
         ROUND(
           100.0 * COUNT(dr.id) FILTER (WHERE dr.completed)
           / NULLIF(COUNT(dr.id), 0),
           2
         ) AS completion_percentage,
         COALESCE(
           json_agg(
             json_build_object(
               'date', dr.record_date,
               'task_id', ti.task_id,
               'task_title', t.title,
               'id', dr.id,
               'task_item_id', ti.id,
               'title', ti.title,
               'is_completed', dr.completed,
               'completed_at', dr.completed_at
             )
             ORDER BY dr.record_date, t.title, ti.sort_order, ti.id
           ) FILTER (WHERE dr.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM history_periods hp
       JOIN task_daily_records dr
         ON dr.record_date >= hp.period_start
        AND dr.record_date < hp.period_start + INTERVAL '1 ${period}'
        AND dr.record_date < CURRENT_DATE
       JOIN task_items ti ON ti.id = dr.task_item_id
       JOIN tasks t ON t.id = ti.task_id AND t.user_id = $4
       GROUP BY hp.period_start
       ORDER BY hp.period_start DESC`,
      [date ?? null, limit, offset, req.user!.id]
    );

    const total = Number(countResult.rows[0].total);
    res.json({
      period,
      selected_date: date ?? null,
      data: result.rows,
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

export async function getDailyTasks(req: Request, res: Response, next: NextFunction) {
  try {
    let date: string;
    if (req.query.date === undefined) {
      const currentDateResult = await pool.query(
        'SELECT CURRENT_DATE::text AS date'
      );
      date = currentDateResult.rows[0].date;
    } else {
      const parsed = dateSchema.safeParse(req.query.date);
      if (!parsed.success) {
        res.status(400).json({ error: "Informe uma data válida no formato YYYY-MM-DD" });
        return;
      }
      date = parsed.data;
    }

    const currentDateResult = await pool.query(
      'SELECT CURRENT_DATE::text AS date'
    );
    if (date === currentDateResult.rows[0].date) {
      await ensureDailyRecords(date, req.user!.id);
    }

    const result = await pool.query(
      `SELECT t.id AS task_id, t.title AS task_title, $1::date AS record_date,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', dr.id,
                    'task_item_id', ti.id,
                    'title', ti.title,
                    'is_completed', dr.completed,
                    'completed_at', dr.completed_at
                  )
                  ORDER BY ti.sort_order, ti.id
                ) FILTER (WHERE dr.id IS NOT NULL),
                '[]'::json
              ) AS items,
              COUNT(dr.id)::int AS total_items,
              COUNT(dr.id) FILTER (WHERE dr.completed)::int AS completed_items
       FROM tasks t
       JOIN task_items ti ON ti.task_id = t.id
       LEFT JOIN task_daily_records dr
         ON dr.task_item_id = ti.id
        AND dr.record_date = $1::date
       WHERE t.user_id = $2
         AND t.start_date <= $1::date
         AND (t.end_date IS NULL OR t.end_date >= $1::date)
         AND t.is_active = TRUE
       GROUP BY t.id
       ORDER BY t.title`,
      [date, req.user!.id]
    );
    res.json({ date, data: result.rows });
  } catch (error) { next(error); }
}

export async function getDailyHistory(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const parsed = historyQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Parâmetros de paginação inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { date, page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  try {
    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT record_date)::int AS total
       FROM task_daily_records dr
       JOIN task_items ti ON ti.id = dr.task_item_id
       JOIN tasks t ON t.id = ti.task_id
       WHERE dr.record_date < CURRENT_DATE AND t.user_id = $1
         AND COALESCE(t.frequencia, 'dia') NOT IN ('semana', 'semanal', 'mes', 'mensal')
         AND ($2::date IS NULL OR dr.record_date = $2::date)`,
      [req.user!.id, date ?? null]
    );

    const result = await pool.query(
      `WITH history_days AS (
         SELECT dr.record_date
         FROM task_daily_records dr
         JOIN task_items ti ON ti.id = dr.task_item_id
         JOIN tasks t ON t.id = ti.task_id
         WHERE dr.record_date < CURRENT_DATE AND t.user_id = $3
           AND COALESCE(t.frequencia, 'dia') NOT IN ('semana', 'semanal', 'mes', 'mensal')
           AND ($4::date IS NULL OR dr.record_date = $4::date)
         GROUP BY dr.record_date
         ORDER BY dr.record_date DESC
         LIMIT $1
         OFFSET $2
       )
       SELECT
         hd.record_date AS date,
         COUNT(dr.id)::int AS total_items,
         COUNT(dr.id) FILTER (WHERE dr.completed)::int AS completed_items,
         COUNT(dr.id) FILTER (WHERE NOT dr.completed)::int AS pending_items,
         ROUND(
           100.0 * COUNT(dr.id) FILTER (WHERE dr.completed)
           / NULLIF(COUNT(dr.id), 0),
           2
         ) AS completion_percentage,
         COALESCE(
           json_agg(
             json_build_object(
               'task_id', ti.task_id,
               'task_title', t.title,
               'id', dr.id,
               'task_item_id', ti.id,
               'title', ti.title,
               'is_completed', dr.completed,
               'completed_at', dr.completed_at
             )
             ORDER BY t.title, ti.sort_order, ti.id
           ) FILTER (WHERE dr.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM history_days hd
       JOIN task_daily_records dr ON dr.record_date = hd.record_date
       JOIN task_items ti ON ti.id = dr.task_item_id
       JOIN tasks t ON t.id = ti.task_id
        AND t.user_id = $3
        AND COALESCE(t.frequencia, 'dia') NOT IN ('semana', 'semanal', 'mes', 'mensal')
       GROUP BY hd.record_date
       ORDER BY hd.record_date DESC`,
      [limit, offset, req.user!.id, date ?? null]
    );

    const total = Number(countResult.rows[0].total);
    res.json({
      period: 'day',
      selected_date: date ?? null,
      data: result.rows,
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

export async function getDailyHistoryByDate(req: Request, res: Response, next: NextFunction) {
  const parsedDate = dateSchema.safeParse(req.params.date);
  if (!parsedDate.success) {
    res.status(400).json({ error: 'Informe uma data válida no formato YYYY-MM-DD.' });
    return;
  }

  try {
    const date = parsedDate.data;
    const currentDate = await pool.query('SELECT CURRENT_DATE::text AS date');
    if (date === currentDate.rows[0].date) {
      await ensureDailyRecords(date, req.user!.id);
    }

    const result = await pool.query(
      `SELECT dr.id, dr.record_date AS date, dr.task_item_id, ti.title AS item_title,
              ti.sort_order, t.id AS task_id, t.title AS task_title,
              dr.completed AS is_completed, dr.completed_at
       FROM public.task_daily_records dr
       JOIN public.task_items ti ON ti.id = dr.task_item_id
       JOIN public.tasks t ON t.id = ti.task_id
       WHERE dr.record_date = $1::date AND t.user_id = $2
         AND COALESCE(t.frequencia, 'dia') NOT IN ('semana', 'semanal', 'mes', 'mensal')
       ORDER BY t.title, ti.sort_order, ti.id`,
      [date, req.user!.id]
    );
    const completedItems = result.rows.filter(row => row.is_completed).length;
    const totalItems = result.rows.length;
    res.json({
      period: 'day',
      date,
      summary: {
        total_items: totalItems,
        completed_items: completedItems,
        pending_items: totalItems - completedItems,
        completion_percentage: totalItems ? Number((completedItems * 100 / totalItems).toFixed(2)) : 0,
      },
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
}

export async function getWeeklyHistory(
  req: Request,
  res: Response,
  next: NextFunction
) {
  return getPeriodHistory(req, res, next, 'week');
}

export async function getMonthlyHistory(
  req: Request,
  res: Response,
  next: NextFunction
) {
  return getPeriodHistory(req, res, next, 'month');
}

export async function updateChecklistItem(req: Request, res: Response, next: NextFunction) {
  const bodySchema = z.object({ is_completed: z.boolean() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Envie is_completed como boolean" });
    return;
  }

  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT dr.id, dr.task_item_id, dr.record_date, dr.completed, dr.completed_at,
              ti.title AS item_title
       FROM public.task_daily_records dr
       JOIN public.task_items ti ON ti.id = dr.task_item_id
       JOIN public.tasks t ON t.id = ti.task_id
       WHERE dr.id = $1 AND t.user_id = $2
       FOR UPDATE OF dr`,
      [id, req.user!.id]
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: "Item diário não encontrado" });
      return;
    }

    const previous = existing.rows[0];
    const result = await client.query(
      `UPDATE public.task_daily_records
       SET completed = $1,
           completed_at = CASE WHEN $1 THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE id = $2
       RETURNING id, task_item_id, record_date, completed, completed_at`,
      [parsed.data.is_completed, id]
    );
    const activity = parsed.data.is_completed && !previous.completed
      ? await recordActivity(client, req.user!.id, 'checklist_item_completed', Number(previous.task_item_id), previous.item_title)
      : null;
    await client.query('COMMIT');
    res.json({
      data: { ...result.rows[0], is_completed: result.rows[0].completed },
      activity,
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
}
