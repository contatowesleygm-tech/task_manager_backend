import { Request, Response, NextFunction } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../config/database';
import { recordActivity } from '../services/activity.service';

const goalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional().nullable(),
  target_date: z.string().date(),
  steps: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
});

const updateGoalSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).optional().nullable(),
  target_date: z.string().date().optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'Informe ao menos um campo para atualizar.',
});

const stepSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

const completedSchema = z.object({
  is_completed: z.boolean(),
});

function parseId(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export async function listGoals(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pool.query(
      `SELECT g.id, g.title, g.description, g.target_date, g.created_at, g.updated_at,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', s.id,
                    'title', s.title,
                    'sort_order', s.sort_order,
                    'is_completed', s.is_completed,
                    'completed_at', s.completed_at
                  )
                  ORDER BY s.sort_order, s.id
                ) FILTER (WHERE s.id IS NOT NULL),
                '[]'::json
              ) AS steps
       FROM public.life_goals g
       LEFT JOIN public.life_goal_steps s ON s.goal_id = g.id
       WHERE g.user_id = $1
       GROUP BY g.id
       ORDER BY g.target_date ASC, g.id DESC`,
      [req.user!.id]
    );
    res.status(200).json({ data: result.rows });
  } catch (error) {
    next(error);
  }
}

export async function getGoal(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do objetivo inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT g.id, g.title, g.description, g.target_date, g.created_at, g.updated_at,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', s.id,
                    'title', s.title,
                    'sort_order', s.sort_order,
                    'is_completed', s.is_completed,
                    'completed_at', s.completed_at
                  ) ORDER BY s.sort_order, s.id
                ) FILTER (WHERE s.id IS NOT NULL),
                '[]'::json
              ) AS steps
       FROM public.life_goals g
       LEFT JOIN public.life_goal_steps s ON s.goal_id = g.id
       WHERE g.id = $1 AND g.user_id = $2
       GROUP BY g.id`,
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Objetivo não encontrado.' });
      return;
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function createGoal(req: Request, res: Response, next: NextFunction) {
  const parsed = goalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten() });
    return;
  }

  const { title, description, target_date, steps } = parsed.data;
  let client: PoolClient | undefined;
  try {
    const transaction = await pool.connect();
    client = transaction;
    await transaction.query('BEGIN');
    const goalResult = await transaction.query(
      `INSERT INTO public.life_goals (user_id, title, description, target_date)
       VALUES ($1, $2, $3, $4::date)
       RETURNING id, user_id, title, description, target_date, created_at, updated_at`,
      [req.user!.id, title, description ?? null, target_date]
    );
    const goal = goalResult.rows[0];
    const createdSteps = [];
    for (let index = 0; index < steps.length; index++) {
      const result = await transaction.query(
        `INSERT INTO public.life_goal_steps (goal_id, title, sort_order)
         VALUES ($1, $2, $3)
         RETURNING id, title, sort_order, is_completed, completed_at`,
        [goal.id, steps[index], index]
      );
      createdSteps.push(result.rows[0]);
    }
    await transaction.query('COMMIT');
    res.status(201).json({ data: { ...goal, steps: createdSteps } });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Falha ao desfazer a transação de criação de objetivo:', rollbackError);
      }
    }
    next(error);
  } finally {
    client?.release();
  }
}

export async function updateGoal(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }

  const parsed = updateGoalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten() });
    return;
  }

  const data = parsed.data;
  try {
    const result = await pool.query(
      `UPDATE public.life_goals
       SET title = COALESCE($2, title),
           description = CASE WHEN $3::boolean THEN $4::text ELSE description END,
           target_date = COALESCE($5::date, target_date),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $6
       RETURNING id, title, description, target_date, created_at, updated_at`,
      [
        id,
        data.title ?? null,
        Object.hasOwn(data, 'description'),
        data.description ?? null,
        data.target_date ?? null,
        req.user!.id,
      ]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Objetivo não encontrado' });
      return;
    }
    res.status(200).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function deleteGoal(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  try {
    const result = await pool.query('DELETE FROM public.life_goals WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
    if (!result.rowCount) {
      res.status(404).json({ error: 'Objetivo não encontrado' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function addGoalStep(req: Request, res: Response, next: NextFunction) {
  const goalId = parseId(req.params.id);
  if (!goalId) {
    res.status(400).json({ error: 'ID do objetivo inválido' });
    return;
  }
  const parsed = stepSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO public.life_goal_steps (goal_id, title, sort_order)
       SELECT g.id, $2, COALESCE(MAX(s.sort_order), -1) + 1
       FROM public.life_goals g
       LEFT JOIN public.life_goal_steps s ON s.goal_id = g.id
       WHERE g.id = $1 AND g.user_id = $3
       GROUP BY g.id
       RETURNING id, title, sort_order, is_completed, completed_at`,
      [goalId, parsed.data.title, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Objetivo não encontrado' });
      return;
    }
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateGoalStep(req: Request, res: Response, next: NextFunction) {
  const goalId = parseId(req.params.id);
  const stepId = parseId(req.params.stepId);
  if (!goalId || !stepId) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  const parsed = completedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Envie is_completed como boolean' });
    return;
  }

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT s.id, s.title, s.is_completed, g.title AS goal_title
       FROM public.life_goal_steps s
       JOIN public.life_goals g ON g.id = s.goal_id
       WHERE s.goal_id = $1 AND s.id = $2 AND g.user_id = $3
       FOR UPDATE OF s`,
      [goalId, stepId, req.user!.id]
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Etapa não encontrada' });
      return;
    }

    const previous = existing.rows[0];
    const result = await client.query(
      `UPDATE public.life_goal_steps
       SET is_completed = $3,
           completed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE goal_id = $1 AND id = $2
       RETURNING id, title, sort_order, is_completed, completed_at`,
      [goalId, stepId, parsed.data.is_completed]
    );

    const activities: Awaited<ReturnType<typeof recordActivity>>[] = [];
    if (parsed.data.is_completed && !previous.is_completed) {
      activities.push(await recordActivity(
        client,
        req.user!.id,
        'goal_step_completed',
        stepId,
        previous.title
      ));
      const pendingSteps = await client.query(
        'SELECT COUNT(*)::int AS total FROM public.life_goal_steps WHERE goal_id = $1 AND is_completed = FALSE',
        [goalId]
      );
      if (pendingSteps.rows[0].total === 0) {
        activities.push(await recordActivity(
          client,
          req.user!.id,
          'goal_completed',
          goalId,
          previous.goal_title
        ));
      }
    }

    await client.query('COMMIT');
    res.status(200).json({
      data: result.rows[0],
      activity: activities.length ? activities[activities.length - 1] : null,
      activities,
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
}
export async function deleteGoalStep(req: Request, res: Response, next: NextFunction) {
  const goalId = parseId(req.params.id);
  const stepId = parseId(req.params.stepId);
  if (!goalId || !stepId) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  try {
    const result = await pool.query(
      `DELETE FROM public.life_goal_steps s
       USING public.life_goals g
       WHERE s.goal_id = $1 AND s.id = $2 AND g.id = s.goal_id AND g.user_id = $3`,
      [goalId, stepId, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Etapa não encontrada' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
