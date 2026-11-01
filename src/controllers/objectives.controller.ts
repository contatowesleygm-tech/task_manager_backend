import { Request, Response, NextFunction } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../config/database';
import { recordActivity } from '../services/activity.service';

const objectiveStatusSchema = z.enum([
  'pendente',
  'em_andamento',
  'concluido',
]);
const stepStatusSchema = z.enum(['pendente', 'concluido']);

const objectiveSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().optional().nullable(),
  target_date: z.string().date(),
  status: objectiveStatusSchema.default('pendente'),
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        status: stepStatusSchema.default('pendente'),
        step_order: z.number().int().min(1).optional(),
      })
    )
    .optional()
    .default([]),
});

const updateObjectiveSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().nullable().optional(),
    target_date: z.string().date().optional(),
    status: objectiveStatusSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Informe ao menos um campo para atualizar.',
  });

const createStepSchema = z.object({
  title: z.string().trim().min(1).max(200),
  status: stepStatusSchema.default('pendente'),
  step_order: z.number().int().min(1).optional(),
});

const updateStepSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    status: stepStatusSchema.optional(),
    step_order: z.number().int().min(1).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Informe ao menos um campo para atualizar.',
  });

function parseId(value: string): number | undefined {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function getObjectiveWithSteps(client: PoolClient, id: number, userId: number) {
  const result = await client.query(
    `SELECT
       o.id,
       o.title,
       o.description,
       o.target_date,
       o.status,
       o.created_at,
       COALESCE(
         json_agg(
           json_build_object(
             'id', s.id,
             'title', s.title,
             'status', s.status,
             'step_order', s.step_order,
             'created_at', s.created_at
           )
           ORDER BY s.step_order, s.id
         ) FILTER (WHERE s.id IS NOT NULL),
         '[]'::json
       ) AS steps
     FROM public.objectives o
     LEFT JOIN public.objective_steps s ON s.objective_id = o.id
     WHERE o.id = $1 AND o.user_id = $2
     GROUP BY o.id`,
    [id, userId]
  );

  return result.rows[0];
}

export async function listObjectives(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await pool.query(
      `SELECT
         o.id,
         o.title,
         o.description,
         o.target_date,
         o.status,
         o.created_at,
         COALESCE(
           json_agg(
             json_build_object(
               'id', s.id,
               'title', s.title,
               'status', s.status,
               'step_order', s.step_order,
               'created_at', s.created_at
             )
             ORDER BY s.step_order, s.id
           ) FILTER (WHERE s.id IS NOT NULL),
           '[]'::json
         ) AS steps
       FROM public.objectives o
       LEFT JOIN public.objective_steps s ON s.objective_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.target_date, o.id DESC`,
      [req.user!.id]
    );

    res.status(200).json({ data: result.rows });
  } catch (error) {
    next(error);
  }
}

export async function getObjective(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do objetivo inválido' });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT
         o.id,
         o.title,
         o.description,
         o.target_date,
         o.status,
         o.created_at,
         COALESCE(
           json_agg(
             json_build_object(
               'id', s.id,
               'title', s.title,
               'status', s.status,
               'step_order', s.step_order,
               'created_at', s.created_at
             )
             ORDER BY s.step_order, s.id
           ) FILTER (WHERE s.id IS NOT NULL),
           '[]'::json
         ) AS steps
       FROM public.objectives o
       LEFT JOIN public.objective_steps s ON s.objective_id = o.id
       WHERE o.id = $1 AND o.user_id = $2
       GROUP BY o.id`,
      [id, req.user!.id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Objetivo não encontrado' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function createObjective(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const parsed = objectiveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const data = parsed.data;
  let client: PoolClient | undefined;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO public.objectives (user_id, title, description, target_date, status)
       VALUES ($1, $2, $3, $4::date, $5)
       RETURNING id`,
      [req.user!.id, data.title, data.description ?? null, data.target_date, data.status]
    );
    const objectiveId = Number(result.rows[0].id);

    for (let index = 0; index < data.steps.length; index++) {
      const step = data.steps[index];
      await client.query(
        `INSERT INTO public.objective_steps
           (objective_id, title, status, step_order)
         VALUES ($1, $2, $3, $4)`,
        [
          objectiveId,
          step.title,
          step.status,
          step.step_order ?? index + 1,
        ]
      );
    }

    const objective = await getObjectiveWithSteps(client, objectiveId, req.user!.id);
    await client.query('COMMIT');
    res.status(201).json({ data: objective });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    next(error);
  } finally {
    client?.release();
  }
}

export async function updateObjective(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do objetivo inválido' });
    return;
  }

  const parsed = updateObjectiveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten() });
    return;
  }

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, title, status FROM public.objectives WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, req.user!.id]
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Objetivo não encontrado' });
      return;
    }

    const previous = existing.rows[0];
    const data = parsed.data;
    const result = await client.query(
      `UPDATE public.objectives
       SET title = COALESCE($2, title),
           description = CASE WHEN $3::boolean THEN $4::text ELSE description END,
           target_date = COALESCE($5::date, target_date),
           status = COALESCE($6, status)
       WHERE id = $1 AND user_id = $7
       RETURNING id, title, description, target_date, status, created_at`,
      [id, data.title ?? null, Object.hasOwn(data, 'description'), data.description ?? null,
        data.target_date ?? null, data.status ?? null, req.user!.id]
    );
    const completedNow = data.status === 'concluido' && previous.status !== 'concluido';
    const activity = completedNow
      ? await recordActivity(client, req.user!.id, 'objective_completed', id, result.rows[0].title)
      : null;
    await client.query('COMMIT');
    res.status(200).json({ data: result.rows[0], activity });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
}
export async function deleteObjective(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do objetivo inválido' });
    return;
  }

  try {
    const result = await pool.query(
      'DELETE FROM public.objectives WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user!.id]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Objetivo não encontrado' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function createObjectiveStep(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const objectiveId = parseId(req.params.id);
  if (!objectiveId) {
    res.status(400).json({ error: 'ID do objetivo inválido' });
    return;
  }

  const parsed = createStepSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const objectiveResult = await pool.query(
      'SELECT id FROM public.objectives WHERE id = $1 AND user_id = $2',
      [objectiveId, req.user!.id]
    );
    if (objectiveResult.rowCount === 0) {
      res.status(404).json({ error: 'Objetivo não encontrado' });
      return;
    }

    const stepOrder =
      parsed.data.step_order ??
      Number(
        (
          await pool.query(
            `SELECT COALESCE(MAX(step_order), 0) + 1 AS next_order
             FROM public.objective_steps
             WHERE objective_id = $1`,
            [objectiveId]
          )
        ).rows[0].next_order
      );

    const result = await pool.query(
      `INSERT INTO public.objective_steps
         (objective_id, title, status, step_order)
       VALUES ($1, $2, $3, $4)
       RETURNING id, objective_id, title, status, step_order, created_at`,
      [
        objectiveId,
        parsed.data.title,
        parsed.data.status,
        stepOrder,
      ]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateObjectiveStep(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const objectiveId = parseId(req.params.id);
  const stepId = parseId(req.params.stepId);
  if (!objectiveId || !stepId) {
    res.status(400).json({ error: 'ID do objetivo ou da etapa inválido' });
    return;
  }

  const parsed = updateStepSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten() });
    return;
  }

  const data = parsed.data;
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT s.id, s.title, s.status
       FROM public.objective_steps s
       JOIN public.objectives o ON o.id = s.objective_id
       WHERE s.objective_id = $1 AND s.id = $2 AND o.user_id = $3
       FOR UPDATE OF s`,
      [objectiveId, stepId, req.user!.id]
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Etapa não encontrada' });
      return;
    }

    const previous = existing.rows[0];
    const result = await client.query(
      `UPDATE public.objective_steps
       SET title = COALESCE($3, title),
           status = COALESCE($4, status),
           step_order = COALESCE($5, step_order)
       WHERE objective_id = $1 AND id = $2
       RETURNING id, objective_id, title, status, step_order, created_at`,
      [objectiveId, stepId, data.title ?? null, data.status ?? null, data.step_order ?? null]
    );
    const activity = data.status === 'concluido' && previous.status !== 'concluido'
      ? await recordActivity(client, req.user!.id, 'objective_step_completed', stepId, result.rows[0].title)
      : null;
    await client.query('COMMIT');
    res.json({ data: result.rows[0], activity });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
}
export async function deleteObjectiveStep(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const objectiveId = parseId(req.params.id);
  const stepId = parseId(req.params.stepId);
  if (!objectiveId || !stepId) {
    res.status(400).json({ error: 'ID do objetivo ou da etapa inválido' });
    return;
  }

  try {
    const result = await pool.query(
      `DELETE FROM public.objective_steps
       WHERE objective_id = $1
         AND id = $2
         AND EXISTS (SELECT 1 FROM public.objectives WHERE id = $1 AND user_id = $3)
       RETURNING id`,
      [objectiveId, stepId, req.user!.id]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Etapa não encontrada' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
