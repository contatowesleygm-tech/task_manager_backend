import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';

const taskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10000).optional().nullable(),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional().nullable(),
  items: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  priority: z.enum(['low', 'medium', 'high']),
  frequencia: z.enum(['dia', 'diaria', 'semana', 'semanal', 'mes', 'mensal']),
});

const taskSchema = taskFieldsSchema.extend({
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  frequencia: z
    .enum(['dia', 'diaria', 'semana', 'semanal', 'mes', 'mensal'])
    .default('diaria'),
});

const taskUpdateSchema = taskFieldsSchema
  .omit({ priority: true, frequencia: true })
  .extend({
    priority: z.enum(['low', 'medium', 'high']).optional(),
    frequencia: z
      .enum(['dia', 'diaria', 'semana', 'semanal', 'mes', 'mensal'])
      .optional(),
  });

const taskListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(5),
});

export async function listTasks(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const parsed = taskListQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Parâmetros de paginação inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  try {
    const countResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_active)::int AS active_total,
         COUNT(*) FILTER (WHERE NOT is_active)::int AS inactive_total
       FROM public.tasks WHERE user_id = $1`,
      [req.user!.id]
    );
    const result = await pool.query(
      `SELECT
         t.id,
         t.title,
         t.description,
         t.start_date,
         t.end_date,
         t.is_active,
         t.created_at,
         t.updated_at,
         t.priority,
         t.frequencia,
         COALESCE(
           json_agg(
             json_build_object(
               'id', ti.id,
               'title', ti.title,
               'sort_order', ti.sort_order
             )
             ORDER BY ti.sort_order, ti.id
           ) FILTER (WHERE ti.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM public.tasks t
       LEFT JOIN public.task_items ti
         ON ti.task_id = t.id
       WHERE t.user_id = $3
       GROUP BY t.id
       ORDER BY t.id DESC
       LIMIT $1
       OFFSET $2`,
      [limit, offset, req.user!.id]
    );

    const total = Number(countResult.rows[0].total);
    const activeTotal = Number(countResult.rows[0].active_total);
    const inactiveTotal = Number(countResult.rows[0].inactive_total);

    res.status(200).json({
      data: result.rows,
      pagination: {
        page,
        limit,
        total,
        activeTotal,
        inactiveTotal,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    next(error);
  }
}

// Criar uma tarefa e seus itens dentro de uma transação.
export async function createTask(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const parsed = taskSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const data = parsed.data;
  let client;

  try {
    client = await pool.connect();

    await client.query('BEGIN');

    const taskResult = await client.query(
      `INSERT INTO tasks (
         title,
         description,
         start_date,
         end_date,
         priority,
         frequencia,
         user_id
       )
       VALUES (
         $1,
         $2,
         COALESCE($3::date, CURRENT_DATE),
         $4::date,
         $5,
         $6,
         $7
       )
       RETURNING
         id,
         title,
         description,
         start_date,
         end_date,
         is_active,
         created_at,
         updated_at,
         priority,
         frequencia`,
      [
        data.title,
        data.description ?? null,
        data.start_date ?? null,
        data.end_date ?? null,
        data.priority,
        data.frequencia,
        req.user!.id,
      ]
    );

    const task = taskResult.rows[0];
    const items = [];

    for (let i = 0; i < data.items.length; i++) {
      const itemResult = await client.query(
        `INSERT INTO task_items (
           task_id,
           title,
           sort_order
         )
         VALUES ($1, $2, $3)
         RETURNING id, title, sort_order`,
        [task.id, data.items[i], i]
      );

      items.push(itemResult.rows[0]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      data: {
        ...task,
        items,
      },
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error('Erro ao criar tarefa:', error);
    next(error);
  } finally {
    client?.release();
  }
}

export async function updateTask(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }

  const parsed = taskUpdateSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Dados inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const data = parsed.data;

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const taskResult = await client.query(
      `SELECT id
       FROM tasks
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [id, req.user!.id]
    );

    if (taskResult.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Tarefa não encontrada' });
      return;
    }

    const updatedTaskResult = await client.query(
      `UPDATE tasks
       SET title = $2,
           description = CASE
             WHEN $3::boolean THEN $4::text
             ELSE description
           END,
           start_date = COALESCE($5::date, start_date),
           end_date = CASE
             WHEN $6::boolean THEN $7::date
             ELSE end_date
           END,
           priority = CASE
             WHEN $8::boolean THEN $9
             ELSE priority
           END,
           frequencia = CASE
             WHEN $10::boolean THEN $11
             ELSE frequencia
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $12
       RETURNING
         id,
         title,
         description,
         start_date,
         end_date,
         priority,
         frequencia,
         is_active,
         created_at,
         updated_at`,
      [
        id,
        data.title,
        Object.hasOwn(data, 'description'),
        data.description ?? null,
        data.start_date ?? null,
        Object.hasOwn(data, 'end_date'),
        data.end_date ?? null,
        Object.hasOwn(data, 'priority'),
        data.priority ?? null,
        Object.hasOwn(data, 'frequencia'),
        data.frequencia ?? null,
        req.user!.id,
      ]
    );

    const existingItemsResult = await client.query(
      `SELECT id, title, sort_order
       FROM task_items
       WHERE task_id = $1
       ORDER BY sort_order, id
       FOR UPDATE`,
      [id]
    );
    const existingItems = existingItemsResult.rows;
    const sharedItemCount = Math.min(existingItems.length, data.items.length);

    for (let i = 0; i < sharedItemCount; i++) {
      await client.query(
        `UPDATE task_items
         SET title = $1,
             sort_order = $2
         WHERE id = $3
           AND task_id = $4`,
        [data.items[i], i, existingItems[i].id, id]
      );
    }

    for (let i = sharedItemCount; i < data.items.length; i++) {
      await client.query(
        `INSERT INTO task_items (task_id, title, sort_order)
         VALUES ($1, $2, $3)`,
        [id, data.items[i], i]
      );
    }

    const removedItems = existingItems.slice(data.items.length);
    if (removedItems.length > 0) {
      const removedItemIds = removedItems.map(
        (item: { id: string | number }) => item.id
      );
      await client.query(
        `DELETE FROM task_daily_records
         WHERE task_item_id = ANY($1::bigint[])`,
        [removedItemIds]
      );

      await client.query(
        `DELETE FROM task_items
         WHERE task_id = $1
           AND id = ANY($2::bigint[])`,
        [id, removedItemIds]
      );
    }

    const itemsResult = await client.query(
      `SELECT id, title, sort_order
       FROM task_items
       WHERE task_id = $1
       ORDER BY sort_order, id`,
      [id]
    );

    await client.query('COMMIT');
    res.json({
      data: {
        ...updatedTaskResult.rows[0],
        items: itemsResult.rows,
      },
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    next(error);
  } finally {
    client?.release();
  }
}

// Desativar uma tarefa sem excluir seus dados.
export async function deactivateTask(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: 'ID inválido' });
      return;
    }

    const result = await pool.query(
      `UPDATE tasks
       SET is_active = FALSE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND user_id = $2
         AND is_active = TRUE
       RETURNING id, title, is_active, updated_at`,
      [id, req.user!.id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({
        error: 'Tarefa não encontrada ou já desativada',
      });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function activateTask(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE tasks
       SET is_active = TRUE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id, title, is_active, updated_at`,
      [id, req.user!.id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Tarefa não encontrada' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function deleteTask(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const taskResult = await client.query(
      'SELECT id, title FROM tasks WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, req.user!.id]
    );

    if (taskResult.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Tarefa não encontrada' });
      return;
    }

    await client.query(
      `DELETE FROM task_daily_records
       WHERE task_item_id IN (
         SELECT id
         FROM task_items
         WHERE task_id = $1
       )`,
      [id]
    );
    await client.query('DELETE FROM task_items WHERE task_id = $1', [id]);
    await client.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [id, req.user!.id]);

    await client.query('COMMIT');

    res.status(200).json({
      data: {
        ...taskResult.rows[0],
        deleted: true,
      },
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    next(error);
  } finally {
    client?.release();
  }
}
