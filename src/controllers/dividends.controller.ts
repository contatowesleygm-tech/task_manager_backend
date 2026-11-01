import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';
import {
  AUTO_QUOTE_TYPES,
  assetTypes,
  catalog,
  defaultFrequency,
  frequencies,
  investmentTypes,
  isFiiLike,
  type AssetType,
} from '../services/investment-types';
import { getMarketQuote } from '../services/quote.service';

const fiiSegments = ['papel', 'tijolo', 'hibrido'] as const;
const intervalByFrequency: Record<(typeof frequencies)[number], number> = {
  mensal: 1, trimestral: 3, semestral: 6, anual: 12,
};
const columns = `id, ticker, name, asset_type, fii_segment, quantity::float8 AS quantity,
                 dividend_per_share::float8 AS dividend_per_share, frequency, reference_month,
                 average_price::float8 AS average_price, current_price::float8 AS current_price,
                 auto_price, price_updated_at,
                 ROUND(quantity * average_price, 2)::float8 AS invested_amount,
                 ROUND(quantity * COALESCE(current_price, average_price), 2)::float8 AS current_value,
                 ROUND(quantity * (COALESCE(current_price, average_price) - average_price), 2)::float8 AS profit_loss,
                 payment_day, is_active, notes, created_at, updated_at`;

const optionalFilter = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value, schema.optional());

const fields = {
  ticker: z.string().trim().min(1).max(40).transform(value => value.toUpperCase()),
  name: z.string().trim().max(160).nullable().optional(),
  asset_type: z.enum(assetTypes as [AssetType, ...AssetType[]]),
  quantity: z.number().positive().max(999_999_999_999),
  dividend_per_share: z.number().min(0).max(999_999_999),
  price: z.number().min(0).max(999_999_999),
  frequency: z.enum(frequencies),
  reference_month: z.number().int().min(1).max(12),
  payment_day: z.number().int().min(1).max(31),
  is_active: z.boolean(),
  notes: z.string().trim().max(2000).nullable().optional(),
};

const createSchema = z.object({
  ticker: fields.ticker,
  name: fields.name,
  asset_type: fields.asset_type.default('fii'),
  fii_segment: z.enum(fiiSegments).nullable().optional(),
  quantity: fields.quantity,
  dividend_per_share: fields.dividend_per_share.default(0),
  average_price: fields.price.default(0),
  current_price: fields.price.nullable().optional(),
  auto_price: z.boolean().optional(),
  frequency: fields.frequency.optional(),
  reference_month: fields.reference_month.default(1),
  payment_day: fields.payment_day.default(15),
  is_active: fields.is_active.default(true),
  notes: fields.notes,
});

const updateSchema = z.object({
  ticker: fields.ticker.optional(),
  name: fields.name,
  asset_type: fields.asset_type.optional(),
  fii_segment: z.enum(fiiSegments).nullable().optional(),
  quantity: fields.quantity.optional(),
  dividend_per_share: fields.dividend_per_share.optional(),
  average_price: fields.price.optional(),
  current_price: fields.price.nullable().optional(),
  auto_price: z.boolean().optional(),
  frequency: fields.frequency.optional(),
  reference_month: fields.reference_month.optional(),
  payment_day: fields.payment_day.optional(),
  is_active: fields.is_active.optional(),
  notes: fields.notes,
}).refine(d => Object.keys(d).length > 0, { message: 'Informe ao menos um campo para atualizar.' });

const listSchema = z.object({
  asset_type: optionalFilter(fields.asset_type),
  fii_segment: optionalFilter(z.enum(fiiSegments)),
  active: optionalFilter(z.enum(['true', 'false'])),
  search: optionalFilter(z.string().trim().min(1).max(160)),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const summarySchema = z.object({
  from: optionalFilter(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Use o formato YYYY-MM.' })),
  months: z.preprocess(
    value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.coerce.number().int().min(1).max(36).default(12)
  ),
});

type Holding = {
  id: string; ticker: string; name: string | null; asset_type: AssetType;
  quantity: number; dividend_per_share: number;
  frequency: (typeof frequencies)[number]; reference_month: number; payment_day: number;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

function parseId(value: string): number | undefined {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function pays(holding: Holding, month: number): boolean {
  const interval = intervalByFrequency[holding.frequency];
  return (((month - holding.reference_month) % interval) + interval) % interval === 0;
}

function monthLabel(year: number, month: number) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function resolveFiiSegment(assetType: string, segment: string | null | undefined) {
  return isFiiLike(assetType) ? segment ?? null : null;
}

function hasAutoQuote(assetType: string) {
  return AUTO_QUOTE_TYPES.includes(assetType as AssetType);
}

export function getDividendAssetTypes(_req: Request, res: Response) {
  res.json({ data: catalog() });
}

export async function listDividendHoldings(req: Request, res: Response, next: NextFunction) {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Filtros ou paginação inválidos.', details: parsed.error.flatten() });
    return;
  }
  const { asset_type, fii_segment, active, search, page, limit } = parsed.data;
  const filters = [
    req.user!.id, asset_type ?? null, active === undefined ? null : active === 'true',
    search ? `%${search}%` : null, fii_segment ?? null,
  ];
  const where = `user_id = $1
    AND ($2::text IS NULL OR asset_type = $2)
    AND ($3::boolean IS NULL OR is_active = $3)
    AND ($4::text IS NULL OR ticker ILIKE $4 OR name ILIKE $4)
    AND ($5::text IS NULL OR fii_segment = $5)`;
  try {
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM public.dividend_holdings WHERE ${where}`, filters);
    const result = await pool.query(
      `SELECT ${columns} FROM public.dividend_holdings WHERE ${where}
       ORDER BY ticker LIMIT $6 OFFSET $7`,
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

export async function getDividendProjection(req: Request, res: Response, next: NextFunction) {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Parâmetros inválidos.', details: parsed.error.flatten() });
    return;
  }
  const now = new Date();
  const [startYear, startMonth] = (parsed.data.from ?? monthLabel(now.getFullYear(), now.getMonth() + 1))
    .split('-').map(Number);
  try {
    const result = await pool.query(
      `SELECT id, ticker, name, asset_type, quantity::float8 AS quantity,
              dividend_per_share::float8 AS dividend_per_share, frequency, reference_month, payment_day
       FROM public.dividend_holdings WHERE user_id = $1 AND is_active ORDER BY ticker`,
      [req.user!.id]
    );
    const holdings: Holding[] = result.rows;

    const months = Array.from({ length: parsed.data.months }, (_, index) => {
      const zeroBased = startMonth - 1 + index;
      const year = startYear + Math.floor(zeroBased / 12);
      const month = (zeroBased % 12) + 1;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const items = holdings.filter(h => pays(h, month)).map(h => ({
        holding_id: h.id,
        ticker: h.ticker,
        name: h.name,
        asset_type: h.asset_type,
        quantity: h.quantity,
        dividend_per_share: h.dividend_per_share,
        amount: round2(h.quantity * h.dividend_per_share),
        payment_date: `${monthLabel(year, month)}-${String(Math.min(h.payment_day, lastDay)).padStart(2, '0')}`,
      })).sort((a, b) => a.payment_date.localeCompare(b.payment_date) || a.ticker.localeCompare(b.ticker));
      return { month: monthLabel(year, month), total: round2(items.reduce((sum, i) => sum + i.amount, 0)), items };
    });

    const periodTotal = round2(months.reduce((sum, m) => sum + m.total, 0));
    res.json({
      data: {
        from: months[0].month,
        months_count: months.length,
        period_total: periodTotal,
        monthly_average: round2(periodTotal / months.length),
        months,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function applyQuote(id: string | number, userId: number, ticker: string, assetType: string) {
  const quote = await getMarketQuote(ticker, assetType);
  const result = await pool.query(
    `UPDATE public.dividend_holdings
     SET current_price = $3, price_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND user_id = $2
     RETURNING ${columns}`,
    [id, userId, quote.price]
  );
  return result.rows[0];
}

export async function refreshDividendPrices(req: Request, res: Response, next: NextFunction) {
  const userId = req.user!.id;
  try {
    const holdings = await pool.query(
      `SELECT id, ticker, asset_type FROM public.dividend_holdings
       WHERE user_id = $1 AND is_active AND auto_price AND asset_type = ANY($2::text[])
       ORDER BY ticker LIMIT 100`,
      [userId, AUTO_QUOTE_TYPES]
    );
    const results = await Promise.all(holdings.rows.map(async (holding: { id: string; ticker: string; asset_type: string }) => {
      try {
        const updated = await applyQuote(holding.id, userId, holding.ticker, holding.asset_type);
        return { holding_id: holding.id, ticker: holding.ticker, updated: true, current_price: updated.current_price };
      } catch {
        return {
          holding_id: holding.id, ticker: holding.ticker, updated: false,
          error: 'Cotação indisponível para este ativo.',
        };
      }
    }));
    const updatedCount = results.filter(item => item.updated).length;
    res.json({
      data: { updated_count: updatedCount, failed_count: results.length - updatedCount, results },
    });
  } catch (error) {
    next(error);
  }
}

export async function getDividendPortfolio(req: Request, res: Response, next: NextFunction) {
  const value = 'quantity * COALESCE(current_price, average_price)';
  try {
    const totals = await pool.query(
      `SELECT COUNT(*)::int AS holdings_count,
              COALESCE(SUM(quantity * average_price), 0)::float8 AS invested_total,
              COALESCE(SUM(${value}), 0)::float8 AS current_total,
              MAX(price_updated_at) AS prices_updated_at
       FROM public.dividend_holdings WHERE user_id = $1 AND is_active`,
      [req.user!.id]
    );
    const group = (column: string) => pool.query(
      `SELECT ${column} AS key, COUNT(*)::int AS holdings_count,
              COALESCE(SUM(quantity * average_price), 0)::float8 AS invested_total,
              COALESCE(SUM(${value}), 0)::float8 AS current_total
       FROM public.dividend_holdings WHERE user_id = $1 AND is_active
       GROUP BY ${column} ORDER BY current_total DESC, key`,
      [req.user!.id]
    );
    const [byType, bySegment] = await Promise.all([group('asset_type'), group('fii_segment')]);
    const present = (row: { key: string | null; holdings_count: number; invested_total: number; current_total: number }) => ({
      key: row.key,
      label: row.key && row.key in investmentTypes ? investmentTypes[row.key as AssetType].label : row.key,
      holdings_count: row.holdings_count,
      invested_total: round2(row.invested_total),
      current_total: round2(row.current_total),
      profit_loss: round2(row.current_total - row.invested_total),
    });
    const { holdings_count, invested_total, current_total, prices_updated_at } = totals.rows[0];
    res.json({
      data: {
        holdings_count,
        prices_updated_at,
        invested_total: round2(invested_total),
        current_total: round2(current_total),
        profit_loss: round2(current_total - invested_total),
        profit_loss_percent: invested_total > 0 ? round2((current_total - invested_total) / invested_total * 100) : 0,
        by_asset_type: byType.rows.map(present),
        by_fii_segment: bySegment.rows.filter(row => row.key !== null).map(present),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getDividendHolding(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do ativo inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT ${columns} FROM public.dividend_holdings WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Ativo não encontrado.' });
      return;
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

export async function createDividendHolding(req: Request, res: Response, next: NextFunction) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const autoPrice = d.auto_price ?? d.current_price == null;
  const frequency = d.frequency ?? defaultFrequency(d.asset_type);
  const fiiSegment = resolveFiiSegment(d.asset_type, d.fii_segment);
  try {
    const result = await pool.query(
      `INSERT INTO public.dividend_holdings
         (user_id, ticker, name, asset_type, fii_segment, quantity, dividend_per_share, frequency,
          reference_month, payment_day, is_active, notes, average_price, current_price, auto_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${columns}`,
      [
        req.user!.id, d.ticker, d.name ?? null, d.asset_type, fiiSegment, d.quantity,
        d.dividend_per_share, frequency, d.reference_month, d.payment_day, d.is_active, d.notes ?? null,
        d.average_price, d.current_price ?? null, autoPrice,
      ]
    );
    let holding = result.rows[0];
    if (autoPrice && d.current_price == null && hasAutoQuote(d.asset_type)) {
      try {
        holding = await applyQuote(holding.id, req.user!.id, holding.ticker, d.asset_type);
      } catch {
        // Sem cotação agora: o ativo é salvo e o preço pode ser atualizado depois.
      }
    }
    res.status(201).json({ data: holding });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Você já cadastrou este ativo.' });
      return;
    }
    next(error);
  }
}

export async function updateDividendHolding(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do ativo inválido.' });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  try {
    const result = await pool.query(
      `UPDATE public.dividend_holdings
       SET ticker = COALESCE($3, ticker),
           name = CASE WHEN $4::boolean THEN $5::text ELSE name END,
           asset_type = COALESCE($6, asset_type),
           fii_segment = CASE
             WHEN COALESCE($6, asset_type) NOT IN ('fii', 'fiagro') THEN NULL
             WHEN $15::boolean THEN $16::text
             ELSE fii_segment
           END,
           quantity = COALESCE($7, quantity),
           dividend_per_share = COALESCE($8, dividend_per_share),
           frequency = COALESCE($9, frequency),
           reference_month = COALESCE($10, reference_month),
           payment_day = COALESCE($11, payment_day),
           is_active = COALESCE($12, is_active),
           notes = CASE WHEN $13::boolean THEN $14::text ELSE notes END,
           average_price = COALESCE($17, average_price),
           current_price = CASE WHEN $18::boolean THEN $19::numeric ELSE current_price END,
           auto_price = CASE WHEN $20::boolean THEN $21::boolean ELSE auto_price END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${columns}`,
      [
        id, req.user!.id, d.ticker ?? null, Object.hasOwn(d, 'name'), d.name ?? null,
        d.asset_type ?? null, d.quantity ?? null, d.dividend_per_share ?? null,
        d.frequency ?? null, d.reference_month ?? null, d.payment_day ?? null, d.is_active ?? null,
        Object.hasOwn(d, 'notes'), d.notes ?? null,
        Object.hasOwn(d, 'fii_segment'), d.fii_segment ?? null,
        d.average_price ?? null, Object.hasOwn(d, 'current_price'), d.current_price ?? null,
        d.auto_price !== undefined || d.current_price != null,
        d.auto_price ?? false,
      ]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Ativo não encontrado.' });
      return;
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Você já cadastrou este ativo.' });
      return;
    }
    next(error);
  }
}

export async function deleteDividendHolding(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do ativo inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      'DELETE FROM public.dividend_holdings WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Ativo não encontrado.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
