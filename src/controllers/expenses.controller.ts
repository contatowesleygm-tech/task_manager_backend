import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';

const expenseTypes = ['compra', 'fixa'] as const;
const columns = `id, name, expense_type, category, amount::float8 AS amount, expense_date, due_day,
                 is_active, notes, created_at, updated_at`;

const optionalFilter = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value, schema.optional());

const baseFields = {
  name: z.string().trim().min(1).max(160),
  expense_type: z.enum(expenseTypes),
  category: z.string().trim().min(1).max(60).default('Outros'),
  amount: z.number().positive().max(999_999_999_999),
  expense_date: z.string().date().nullable().optional(),
  due_day: z.number().int().min(1).max(31).nullable().optional(),
  is_active: z.boolean().default(true),
  notes: z.string().trim().max(2000).nullable().optional(),
};

const createSchema = z.object(baseFields)
  .refine(d => d.expense_type !== 'compra' || Boolean(d.expense_date), {
    message: 'Informe a data da compra.', path: ['expense_date'],
  })
  .refine(d => d.expense_type !== 'fixa' || d.due_day != null, {
    message: 'Informe o dia de vencimento da despesa fixa.', path: ['due_day'],
  });

const updateSchema = z.object({
  name: baseFields.name.optional(),
  expense_type: baseFields.expense_type.optional(),
  category: z.string().trim().min(1).max(60).optional(),
  amount: baseFields.amount.optional(),
  expense_date: baseFields.expense_date,
  due_day: baseFields.due_day,
  is_active: z.boolean().optional(),
  notes: baseFields.notes,
}).refine(d => Object.keys(d).length > 0, { message: 'Informe ao menos um campo para atualizar.' });

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Use o formato YYYY-MM.' });

const listSchema = z.object({
  type: optionalFilter(z.enum(expenseTypes)),
  category: optionalFilter(z.string().trim().min(1).max(60)),
  month: optionalFilter(monthSchema),
  active: optionalFilter(z.enum(['true', 'false'])),
  search: optionalFilter(z.string().trim().min(1).max(160)),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const summarySchema = z.object({ month: optionalFilter(monthSchema) });

function parseId(value: string | string[]): number | undefined {
  if (typeof value !== 'string') return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export async function listExpenses(req: Request, res: Response, next: NextFunction) {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Filtros ou paginação inválidos.', details: parsed.error.flatten() });
    return;
  }
  const { type, category, month, active, search, page, limit } = parsed.data;
  const filters = [
    req.user!.id, type ?? null, category ?? null, month ? `${month}-01` : null,
    active === undefined ? null : active === 'true', search ? `%${search}%` : null,
  ];
  // "month" só restringe compras; despesas fixas continuam aparecendo.
  const where = `user_id = $1
    AND ($2::text IS NULL OR expense_type = $2)
    AND ($3::text IS NULL OR category = $3)
    AND ($4::date IS NULL OR expense_type = 'fixa'
         OR date_trunc('month', expense_date) = date_trunc('month', $4::date))
    AND ($5::boolean IS NULL OR is_active = $5)
    AND ($6::text IS NULL OR name ILIKE $6 OR category ILIKE $6 OR notes ILIKE $6)`;
  try {
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM public.expenses WHERE ${where}`, filters);
    const result = await pool.query(
      `SELECT ${columns} FROM public.expenses WHERE ${where}
       ORDER BY expense_type, expense_date DESC NULLS LAST, due_day, id DESC
       LIMIT $7 OFFSET $8`,
      [...filters, limit, (page - 1) * limit]
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

export async function listExpenseCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pool.query(
      `SELECT category, COUNT(*)::int AS expense_count
       FROM public.expenses WHERE user_id = $1
       GROUP BY category ORDER BY category`,
      [req.user!.id]
    );
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
}

export async function getExpensesSummary(req: Request, res: Response, next: NextFunction) {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Mês inválido.', details: parsed.error.flatten() });
    return;
  }
  const month = parsed.data.month ?? new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const [year, monthNumber] = month.split('-').map(Number);
  const previousMonth = new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7);
  const scope = `user_id = $1 AND (
      (expense_type = 'fixa' AND is_active)
      OR (expense_type = 'compra' AND expense_date >= $2::date
          AND expense_date < ($2::date + interval '1 month')::date)
    )`;
  try {
    const [totals, previousTotals, byCategory, dailySpending] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(amount) FILTER (WHERE expense_type = 'fixa'), 0)::float8 AS fixed_total,
           COALESCE(SUM(amount) FILTER (WHERE expense_type = 'compra'), 0)::float8 AS purchases_total,
           COALESCE(SUM(amount), 0)::float8 AS total
         FROM public.expenses WHERE ${scope}`,
        [req.user!.id, monthStart]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount), 0)::float8 AS total
         FROM public.expenses
         WHERE user_id = $1 AND (
           (expense_type = 'fixa' AND is_active)
           OR (expense_type = 'compra'
               AND expense_date >= ($2::date - interval '1 month')::date
               AND expense_date < $2::date)
         )`,
        [req.user!.id, monthStart]
      ),
      pool.query(
        `WITH categories AS (
           SELECT category, SUM(amount) AS total, COUNT(*)::int AS expense_count
           FROM public.expenses WHERE ${scope}
           GROUP BY category
         )
         SELECT category, total::float8 AS total, expense_count,
                ROUND(total * 100 / NULLIF(SUM(total) OVER (), 0), 2)::float8 AS percentage
         FROM categories ORDER BY total DESC, category`,
        [req.user!.id, monthStart]
      ),
      pool.query(
        `WITH days AS (
           SELECT generate_series(
             $2::date, ($2::date + interval '1 month' - interval '1 day')::date, interval '1 day'
           )::date AS date
         ),
         spending AS (
           SELECT expense_date AS date, SUM(amount)::float8 AS total, COUNT(*)::int AS expense_count
           FROM public.expenses
           WHERE user_id = $1 AND expense_type = 'compra'
             AND expense_date >= $2::date AND expense_date < ($2::date + interval '1 month')::date
           GROUP BY expense_date
         )
         SELECT days.date, COALESCE(spending.total, 0)::float8 AS total,
                COALESCE(spending.expense_count, 0)::int AS expense_count
         FROM days LEFT JOIN spending ON spending.date = days.date
         ORDER BY days.date`,
        [req.user!.id, monthStart]
      ),
    ]);
    const previousTotal = previousTotals.rows[0].total as number;
    const total = totals.rows[0].total as number;
    const difference = Math.round((total - previousTotal) * 100) / 100;
    const changePercentage = previousTotal === 0
      ? null
      : Math.round((difference / previousTotal) * 10_000) / 100;
    res.json({
      data: {
        month,
        ...totals.rows[0],
        comparison: {
          previous_month: previousMonth,
          previous_total: previousTotal,
          difference,
          change_percentage: changePercentage,
        },
        top_category: byCategory.rows[0] ?? null,
        by_category: byCategory.rows,
        daily_spending: dailySpending.rows,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getExpense(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID da despesa inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT ${columns} FROM public.expenses WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Despesa não encontrada.' });
      return;
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function createExpense(req: Request, res: Response, next: NextFunction) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const isFixed = d.expense_type === 'fixa';
  try {
    const result = await pool.query(
      `INSERT INTO public.expenses
         (user_id, name, expense_type, category, amount, expense_date, due_day, is_active, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${columns}`,
      [
        req.user!.id, d.name, d.expense_type, d.category, d.amount,
        isFixed ? null : d.expense_date, isFixed ? d.due_day : null, d.is_active, d.notes ?? null,
      ]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateExpense(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID da despesa inválido.' });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  try {
    const current = await pool.query(
      `SELECT expense_type, expense_date::text AS expense_date, due_day
       FROM public.expenses WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id]
    );
    if (!current.rowCount) {
      res.status(404).json({ error: 'Despesa não encontrada.' });
      return;
    }
    const row = current.rows[0];
    const type = d.expense_type ?? row.expense_type;
    const date = Object.hasOwn(d, 'expense_date') ? d.expense_date : row.expense_date;
    const dueDay = Object.hasOwn(d, 'due_day') ? d.due_day : row.due_day;
    if (type === 'compra' && !date) {
      res.status(400).json({ error: 'Informe a data da compra.' });
      return;
    }
    if (type === 'fixa' && dueDay == null) {
      res.status(400).json({ error: 'Informe o dia de vencimento da despesa fixa.' });
      return;
    }

    const result = await pool.query(
      `UPDATE public.expenses
       SET name = COALESCE($3, name),
           expense_type = $4,
           category = COALESCE($5, category),
           amount = COALESCE($6, amount),
           expense_date = $7::date,
           due_day = $8::smallint,
           is_active = COALESCE($9, is_active),
           notes = CASE WHEN $10::boolean THEN $11::text ELSE notes END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${columns}`,
      [
        id, req.user!.id, d.name ?? null, type, d.category ?? null, d.amount ?? null,
        type === 'compra' ? date : null, type === 'fixa' ? dueDay : null,
        d.is_active ?? null, Object.hasOwn(d, 'notes'), d.notes ?? null,
      ]
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function deleteExpense(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID da despesa inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      'DELETE FROM public.expenses WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Despesa não encontrada.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
