import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';

const eventTypeSchema = z.enum(['lembrete', 'atividade', 'aniversario']);
const eventStatusSchema = z.enum(['pendente', 'concluido', 'cancelado']);
const dateSchema = z.string().date();
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
  message: 'Use o formato HH:MM',
});

const createEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().optional().nullable(),
  type: eventTypeSchema,
  event_date: dateSchema,
  event_time: timeSchema.optional().nullable(),
  reminder_at: z.string().datetime({ offset: true }).optional().nullable(),
  repeat_yearly: z.boolean().optional(),
  status: eventStatusSchema.default('pendente'),
});

const updateEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().nullable().optional(),
    type: eventTypeSchema.optional(),
    event_date: dateSchema.optional(),
    event_time: timeSchema.nullable().optional(),
    reminder_at: z.string().datetime({ offset: true }).nullable().optional(),
    repeat_yearly: z.boolean().optional(),
    status: eventStatusSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Informe ao menos um campo para atualizar.',
  });

const listEventsSchema = z
  .object({
    date: dateSchema.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(
    ({ date, from, to }) => !date || (!from && !to),
    { message: 'Use "date" ou o intervalo "from"/"to", não ambos', path: ['date'] }
  )
  .refine(
    ({ from, to }) =>
      !from ||
      !to ||
      new Date(`${from}T00:00:00Z`) <= new Date(`${to}T00:00:00Z`),
    { message: '"from" deve ser anterior ou igual a "to"', path: ['from'] }
  )
  .refine(
    ({ from, to }) =>
      !from ||
      !to ||
      (new Date(`${to}T00:00:00Z`).getTime() -
        new Date(`${from}T00:00:00Z`).getTime()) /
        86_400_000 <=
        366,
    { message: 'O intervalo máximo da agenda é de 366 dias', path: ['to'] }
  );

const alertQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function parseId(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function eventRangeCte(userId: number, date?: string, from?: string, to?: string) {
  if (date) {
    return {
      sql: `WITH occurrences AS (
        SELECT
          e.id,
          e.title,
          e.description,
          e.type,
          e.event_date,
          e.event_time,
          e.reminder_at,
          e.repeat_yearly,
          e.status,
          e.created_at,
          e.updated_at,
          $1::date AS occurrence_date
        FROM public.schedule_events e
        WHERE e.user_id = $2 AND (e.event_date = $1::date
           OR (
             e.repeat_yearly
             AND EXTRACT(MONTH FROM e.event_date) = EXTRACT(MONTH FROM $1::date)
             AND EXTRACT(DAY FROM e.event_date) = EXTRACT(DAY FROM $1::date)
           ))
      )`,
      values: [date, userId],
      paginationParameterIndex: 3,
    };
  }

  if (!from && !to) {
    return {
      sql: `WITH occurrences AS (
        SELECT
          e.id,
          e.title,
          e.description,
          e.type,
          e.event_date,
          e.event_time,
          e.reminder_at,
          e.repeat_yearly,
          e.status,
          e.created_at,
          e.updated_at,
          e.event_date AS occurrence_date
        FROM public.schedule_events e WHERE e.user_id = $1
      )`,
      values: [userId],
      paginationParameterIndex: 2,
    };
  }

  return {
    sql: `WITH bounds AS (
    SELECT
      COALESCE($1::date, CURRENT_DATE) AS from_date,
      COALESCE($2::date, COALESCE($1::date, CURRENT_DATE) + 30) AS to_date
  ),
  occurrences AS (
    SELECT
      e.id,
      e.title,
      e.description,
      e.type,
      e.event_date,
      e.event_time,
      e.reminder_at,
      e.repeat_yearly,
      e.status,
      e.created_at,
      e.updated_at,
      occurrence_date::date AS occurrence_date
    FROM public.schedule_events e
    CROSS JOIN bounds b
    CROSS JOIN LATERAL generate_series(
      b.from_date::timestamp,
      b.to_date::timestamp,
      INTERVAL '1 day'
    ) AS days(occurrence_date)
    WHERE e.user_id = $3 AND ((
      e.repeat_yearly
      AND EXTRACT(MONTH FROM occurrence_date) = EXTRACT(MONTH FROM e.event_date)
      AND EXTRACT(DAY FROM occurrence_date) = EXTRACT(DAY FROM e.event_date)
    ) OR (
      NOT e.repeat_yearly
      AND occurrence_date::date = e.event_date
    ))
  )`,
    values: [from ?? null, to ?? null, userId],
    paginationParameterIndex: 4,
  };
}

export async function listScheduleEvents(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const parsed = listEventsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Parâmetros de consulta inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { date, from, to, page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const query = eventRangeCte(req.user!.id, date, from, to);

  try {
    const countResult = await pool.query(
      `${query.sql}
       SELECT COUNT(*)::int AS total FROM occurrences`,
      query.values
    );
    const result = await pool.query(
      `${query.sql}
       SELECT *
       FROM occurrences
       ORDER BY occurrence_date, event_time NULLS FIRST, id
       LIMIT $${query.paginationParameterIndex}
       OFFSET $${query.paginationParameterIndex + 1}`,
      [...query.values, limit, offset]
    );

    const total = Number(countResult.rows[0].total);
    res.json({
      data: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
      ...(date ? { date } : {}),
      ...(!date && (from || to) ? { range: { from: from ?? null, to: to ?? null } } : {}),
    });
  } catch (error) {
    next(error);
  }
}

export async function listScheduleAlerts(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const parsed = alertQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Parâmetros de paginação inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const alertsCte = `WITH alerts AS (
    SELECT
      e.id,
      e.title,
      e.description,
      e.type,
      e.event_date,
      e.event_time,
      e.reminder_at,
      e.repeat_yearly,
      e.status,
      e.created_at,
      e.updated_at,
      COALESCE(upcoming.occurrence_date, e.event_date) AS occurrence_date,
      ARRAY_REMOVE(
        ARRAY[
          CASE
            WHEN e.reminder_at <= CURRENT_TIMESTAMP THEN 'lembrete_definido'
          END,
          CASE
            WHEN upcoming.occurrence_date IS NOT NULL THEN 'evento_proximo'
          END
        ]::text[],
        NULL
      ) AS alert_reasons
    FROM public.schedule_events e
    LEFT JOIN LATERAL (
      SELECT occurrence_day::date AS occurrence_date
      FROM generate_series(
        CURRENT_DATE::timestamp,
        (CURRENT_DATE + 1)::timestamp,
        INTERVAL '1 day'
      ) AS days(occurrence_day)
      WHERE (
        (
          e.repeat_yearly
          AND EXTRACT(MONTH FROM occurrence_day) = EXTRACT(MONTH FROM e.event_date)
          AND EXTRACT(DAY FROM occurrence_day) = EXTRACT(DAY FROM e.event_date)
        ) OR (
          NOT e.repeat_yearly
          AND occurrence_day::date = e.event_date
        )
      )
        AND (occurrence_day::date + COALESCE(e.event_time, TIME '23:59:59'))
          BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '24 hours'
      ORDER BY occurrence_day
      LIMIT 1
    ) upcoming ON TRUE
    WHERE e.user_id = $1
      AND e.status = 'pendente'
      AND (e.reminder_at <= CURRENT_TIMESTAMP OR upcoming.occurrence_date IS NOT NULL)
  )`;

  try {
    const countResult = await pool.query(
      `${alertsCte} SELECT COUNT(*)::int AS total FROM alerts`, [req.user!.id]
    );
    const result = await pool.query(
      `${alertsCte}
       SELECT *
       FROM alerts
       ORDER BY occurrence_date, event_time NULLS FIRST, id
       LIMIT $2
       OFFSET $3`,
      [req.user!.id, limit, offset]
    );

    const total = Number(countResult.rows[0].total);
    res.json({
      data: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
      window_hours: 24,
    });
  } catch (error) {
    next(error);
  }
}

export async function createScheduleEvent(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const data = parsed.data;
  const repeatYearly = data.repeat_yearly ?? data.type === 'aniversario';

  try {
    const result = await pool.query(
      `INSERT INTO public.schedule_events
         (user_id, title, description, type, event_date, event_time, reminder_at, repeat_yearly, status)
       VALUES ($1, $2, $3, $4, $5::date, $6::time, $7::timestamptz, $8, $9)
       RETURNING id, title, description, type, event_date, event_time,
                 reminder_at, repeat_yearly, status, created_at, updated_at`,
      [
        req.user!.id,
        data.title,
        data.description ?? null,
        data.type,
        data.event_date,
        data.event_time ?? null,
        data.reminder_at ?? null,
        repeatYearly,
        data.status,
      ]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateScheduleEvent(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do agendamento inválido' });
    return;
  }

  const parsed = updateEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const data = parsed.data;
  try {
    const result = await pool.query(
      `UPDATE public.schedule_events
       SET title = COALESCE($2, title),
           description = CASE WHEN $3::boolean THEN $4::text ELSE description END,
           type = COALESCE($5, type),
           event_date = COALESCE($6::date, event_date),
           event_time = CASE WHEN $7::boolean THEN $8::time ELSE event_time END,
           reminder_at = CASE WHEN $9::boolean THEN $10::timestamptz ELSE reminder_at END,
           repeat_yearly = COALESCE($11, repeat_yearly),
           status = COALESCE($12, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $13
       RETURNING id, title, description, type, event_date, event_time,
                 reminder_at, repeat_yearly, status, created_at, updated_at`,
      [
        id,
        data.title ?? null,
        Object.hasOwn(data, 'description'),
        data.description ?? null,
        data.type ?? null,
        data.event_date ?? null,
        Object.hasOwn(data, 'event_time'),
        data.event_time ?? null,
        Object.hasOwn(data, 'reminder_at'),
        data.reminder_at ?? null,
        data.repeat_yearly ?? null,
        data.status ?? null,
        req.user!.id,
      ]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Agendamento não encontrado' });
      return;
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function deleteScheduleEvent(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do agendamento inválido' });
    return;
  }

  try {
    const result = await pool.query(
      'DELETE FROM public.schedule_events WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user!.id]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Agendamento não encontrado' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
