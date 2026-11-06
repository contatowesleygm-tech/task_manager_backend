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
import { getBcbCdiRate } from '../services/market/bcb.service';

const fiiSegments = ['papel', 'tijolo', 'hibrido'] as const;
const intervalByFrequency: Record<(typeof frequencies)[number], number> = {
  mensal: 1, trimestral: 3, semestral: 6, anual: 12,
};
const columns = `id, ticker, name, asset_type, fii_segment, quantity::float8 AS quantity,
                 dividend_per_share::float8 AS dividend_per_share, frequency, reference_month,
                 average_price::float8 AS average_price, current_price::float8 AS current_price,
                 cdi_percent::float8 AS cdi_percent,
                 applied_amount::float8 AS applied_amount,
                 investment_date::text AS investment_date,
                 auto_price, price_updated_at,
                 ROUND(CASE WHEN asset_type = 'renda_fixa' THEN COALESCE(NULLIF(applied_amount, 0), quantity * average_price, 0)
                            ELSE quantity * average_price END, 2)::float8 AS invested_amount,
                 ROUND(CASE WHEN asset_type = 'renda_fixa' THEN COALESCE(NULLIF(applied_amount, 0), NULLIF(current_price, 0), quantity * average_price, 0)
                            ELSE quantity * COALESCE(current_price, average_price) END, 2)::float8 AS current_value,
                 ROUND(CASE WHEN asset_type = 'renda_fixa' THEN COALESCE(NULLIF(applied_amount, 0), NULLIF(current_price, 0), quantity * average_price, 0)
                                      - COALESCE(NULLIF(applied_amount, 0), quantity * average_price, 0)
                            ELSE quantity * (COALESCE(current_price, average_price) - average_price) END, 2)::float8 AS profit_loss,
                 payment_day, is_active, notes, created_at, updated_at`;

const optionalFilter = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value, schema.optional());

const fields = {
  ticker: z.string().trim().min(1).max(40).transform(value => value.toUpperCase()),
  name: z.string().trim().max(160).nullable().optional(),
  asset_type: z.enum(assetTypes as [AssetType, ...AssetType[]]),
  quantity: z.coerce.number().positive().max(999_999_999_999).optional(),
  dividend_per_share: z.coerce.number().min(0).max(999_999_999),
  price: z.coerce.number().min(0).max(999_999_999),
  frequency: z.enum(frequencies),
  reference_month: z.coerce.number().int().min(1).max(12),
  payment_day: z.coerce.number().int().min(1).max(31),
  is_active: z.coerce.boolean(),
  notes: z.string().trim().max(2000).nullable().optional(),
  cdi_percent: z.coerce.number().min(0).max(1000).optional(),
  applied_amount: z.coerce.number().min(0).max(999_999_999_999).optional(),
  investment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
};

function normalizeFixedIncomePayload<T extends Record<string, any>>(payload: T | undefined): T {
  if (!payload || typeof payload !== 'object') return (payload ?? {}) as T;
  const normalized = { ...payload } as Record<string, any>;
  const cdiPercent = normalized.cdi_percent ?? normalized.cdi ?? normalized.cdi_percentual ?? normalized.percentual_cdi;
  const appliedAmount = normalized.applied_amount ?? normalized.valor_aplicado ?? normalized.valor_investido ?? normalized.invested_amount;
  const investmentDate = normalized.investment_date ?? normalized.data_investimento ?? normalized.investmentDate;
  if (cdiPercent === undefined) delete normalized.cdi_percent;
  else normalized.cdi_percent = cdiPercent;
  if (appliedAmount === undefined) delete normalized.applied_amount;
  else normalized.applied_amount = appliedAmount;
  if (investmentDate === undefined) delete normalized.investment_date;
  else normalized.investment_date = investmentDate;
  return normalized as T;
}

const createSchema = z.object({
  ticker: fields.ticker,
  name: fields.name,
  asset_type: fields.asset_type.default('fii'),
  fii_segment: z.enum(fiiSegments).nullable().optional(),
  quantity: fields.quantity,
  dividend_per_share: fields.dividend_per_share.default(0),
  average_price: fields.price.default(0),
  current_price: fields.price.nullable().optional(),
  auto_price: z.coerce.boolean().optional(),
  frequency: fields.frequency.optional(),
  reference_month: fields.reference_month.default(1),
  payment_day: fields.payment_day.default(15),
  is_active: fields.is_active.default(true),
  notes: fields.notes,
  cdi_percent: fields.cdi_percent,
  applied_amount: fields.applied_amount,
  investment_date: fields.investment_date,
}).superRefine((data, context) => {
  if (data.asset_type !== 'renda_fixa') return;
  if (data.applied_amount == null || data.applied_amount <= 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['applied_amount'], message: 'Informe um valor aplicado maior que zero.' });
  }
  if (data.cdi_percent == null || data.cdi_percent <= 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['cdi_percent'], message: 'Informe um percentual do CDI maior que zero.' });
  }
  if (!data.investment_date) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['investment_date'], message: 'Informe a data do investimento.' });
  }
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
  auto_price: z.coerce.boolean().optional(),
  frequency: fields.frequency.optional(),
  reference_month: fields.reference_month.optional(),
  payment_day: fields.payment_day.optional(),
  is_active: fields.is_active.optional(),
  notes: fields.notes,
  cdi_percent: fields.cdi_percent,
  applied_amount: fields.applied_amount,
  investment_date: fields.investment_date,
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
  cdi_rate: z.preprocess(
    value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.coerce.number().min(0).max(1000).optional()
  ),
});

type Holding = {
  id: string; ticker: string; name: string | null; asset_type: AssetType;
  quantity: number; dividend_per_share: number;
  frequency: (typeof frequencies)[number]; reference_month: number; payment_day: number;
  cdi_percent?: number | null; applied_amount?: number | null; investment_date?: string | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const roundRate = (value: number) => Math.round(value * 10_000) / 10_000;

function parseId(value: string | string[]): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function pays(holding: Holding, month: number): boolean {
  const interval = intervalByFrequency[holding.frequency];
  return (((month - holding.reference_month) % interval) + interval) % interval === 0;
}

function monthLabel(year: number, month: number) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function fixedIncomeInvestmentDate(value?: string | null): Date | null {
  const datePart = value?.slice(0, 10);
  if (!datePart || !/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const [year, month, day] = datePart.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function isFixedIncomeHolding(holding: Holding): boolean {
  return holding.asset_type === 'renda_fixa'
    && Number.isFinite(holding.cdi_percent)
    && Number(holding.cdi_percent) > 0
    && Number.isFinite(holding.applied_amount)
    && Number(holding.applied_amount) > 0
    && fixedIncomeInvestmentDate(holding.investment_date) !== null;
}

function monthlyFixedIncomeAmount(holding: Holding, year: number, month: number, cdiRate: number): {
  gross_amount: number; tax_amount: number; net_amount: number; income_tax_rate: number;
} {
  if (!isFixedIncomeHolding(holding)) {
    return { gross_amount: 0, tax_amount: 0, net_amount: 0, income_tax_rate: 0 };
  }
  const principal = Number(holding.applied_amount ?? 0);
  const cdiFraction = Number(holding.cdi_percent) / 100;
  const monthlyEffectiveRate = Math.pow(1 + cdiRate / 100, cdiFraction / 12) - 1;
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const investmentDate = fixedIncomeInvestmentDate(holding.investment_date)!;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (investmentDate.getTime() >= monthStart.getTime() + daysInMonth * 86_400_000) {
    return { gross_amount: 0, tax_amount: 0, net_amount: 0, income_tax_rate: 0 };
  }
  const effectiveStart = investmentDate > monthStart ? investmentDate : monthStart;
  const activeDays = daysInMonth - effectiveStart.getUTCDate() + 1;
  const fraction = Math.min(1, activeDays / daysInMonth);
  const gross = principal * (Math.pow(1 + monthlyEffectiveRate, fraction) - 1);
  const paymentDay = Math.min(holding.payment_day || 15, daysInMonth);
  const paymentDate = new Date(Date.UTC(year, month - 1, paymentDay));
  const holdingDays = Math.max(0, Math.floor((paymentDate.getTime() - investmentDate.getTime()) / 86_400_000));
  const incomeTaxRate = holdingDays <= 180 ? 0.225
    : holdingDays <= 360 ? 0.20
      : holdingDays <= 720 ? 0.175
        : 0.15;
  const tax = gross * incomeTaxRate;
  return {
    gross_amount: round2(gross),
    tax_amount: round2(tax),
    net_amount: round2(gross - tax),
    income_tax_rate: incomeTaxRate,
  };
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

export async function getDividendCdiRate(_req: Request, res: Response, next: NextFunction) {
  try {
    const cdi = await getBcbCdiRate();
    res.json({
      data: {
        rate: cdi.rate,
        reference_date: cdi.referenceDate,
        source: 'Banco Central do Brasil (SGS 4389)',
      },
    });
  } catch (error) {
    next(error);
  }
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
  const cdiRate = parsed.data.cdi_rate ?? 13.65;
  try {
    const result = await pool.query(
      `SELECT id, ticker, name, asset_type, quantity::float8 AS quantity,
              dividend_per_share::float8 AS dividend_per_share, frequency, reference_month, payment_day,
              cdi_percent::float8 AS cdi_percent, applied_amount::float8 AS applied_amount,
              investment_date::text AS investment_date
       FROM public.dividend_holdings WHERE user_id = $1 AND is_active ORDER BY ticker`,
      [req.user!.id]
    );
    const holdings: Holding[] = result.rows;

    const months = Array.from({ length: parsed.data.months }, (_, index) => {
      const zeroBased = startMonth - 1 + index;
      const year = startYear + Math.floor(zeroBased / 12);
      const month = (zeroBased % 12) + 1;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const items: Array<{
        holding_id: string; ticker: string; name: string | null; asset_type: AssetType;
        quantity?: number; dividend_per_share?: number; cdi_percent?: number | null;
        applied_amount?: number | null; investment_date?: string | null;
        gross_amount: number; tax_amount: number; net_amount: number; amount: number; payment_date: string;
        income_tax_rate: number;
      }> = holdings.flatMap(h => {
        if (isFixedIncomeHolding(h)) {
          const fixedIncome = monthlyFixedIncomeAmount(h, year, month, cdiRate);
          if (fixedIncome.net_amount <= 0) return [];
          return [{
            holding_id: h.id,
            ticker: h.ticker,
            name: h.name,
            asset_type: h.asset_type,
            quantity: h.quantity,
            cdi_percent: h.cdi_percent,
            applied_amount: h.applied_amount,
            investment_date: h.investment_date,
            gross_amount: fixedIncome.gross_amount,
            tax_amount: fixedIncome.tax_amount,
            net_amount: fixedIncome.net_amount,
            amount: fixedIncome.net_amount,
            income_tax_rate: fixedIncome.income_tax_rate,
            payment_date: `${monthLabel(year, month)}-${String(Math.min(h.payment_day || 15, lastDay)).padStart(2, '0')}`,
          }];
        }

        if (!pays(h, month)) return [];
        const grossAmount = round2(h.quantity * h.dividend_per_share);
        return [{
          holding_id: h.id,
          ticker: h.ticker,
          name: h.name,
          asset_type: h.asset_type,
          quantity: h.quantity,
          dividend_per_share: h.dividend_per_share,
          cdi_percent: undefined,
          applied_amount: undefined,
          investment_date: undefined,
          gross_amount: grossAmount,
          tax_amount: 0,
          net_amount: grossAmount,
          amount: grossAmount,
          income_tax_rate: 0,
          payment_date: `${monthLabel(year, month)}-${String(Math.min(h.payment_day, lastDay)).padStart(2, '0')}`,
        }];
      });
      items.sort((a, b) => a.payment_date.localeCompare(b.payment_date) || a.ticker.localeCompare(b.ticker));
      const grossTotal = round2(items.reduce((sum, i) => sum + i.gross_amount, 0));
      const taxTotal = round2(items.reduce((sum, i) => sum + i.tax_amount, 0));
      const netTotal = round2(items.reduce((sum, i) => sum + i.net_amount, 0));
      const monthIncomeTaxRate = grossTotal > 0 ? roundRate(taxTotal / grossTotal) : 0;
      return {
        month: monthLabel(year, month),
        gross_total: grossTotal,
        tax_total: taxTotal,
        income_tax_rate: monthIncomeTaxRate,
        total: netTotal,
        net_total: netTotal,
        items,
      };
    });

    const periodGrossTotal = round2(months.reduce((sum, m) => sum + m.gross_total, 0));
    const periodTaxTotal = round2(months.reduce((sum, m) => sum + m.tax_total, 0));
    const periodNetTotal = round2(months.reduce((sum, m) => sum + m.net_total, 0));
    const periodIncomeTaxRate = periodGrossTotal > 0 ? roundRate(periodTaxTotal / periodGrossTotal) : 0;
    res.json({
      data: {
        from: months[0].month,
        months_count: months.length,
        cdi_rate: cdiRate,
        income_tax_rate: periodIncomeTaxRate,
        gross_total: periodGrossTotal,
        tax_total: periodTaxTotal,
        total: periodNetTotal,
        net_total: periodNetTotal,
        period_total: periodNetTotal,
        monthly_average: round2(periodNetTotal / months.length),
        monthly_average_gross: round2(periodGrossTotal / months.length),
        monthly_average_tax: round2(periodTaxTotal / months.length),
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
  const invested = `CASE WHEN asset_type = 'renda_fixa' THEN COALESCE(NULLIF(applied_amount, 0), quantity * average_price, 0)
                          ELSE quantity * average_price END`;
  const value = `CASE WHEN asset_type = 'renda_fixa' THEN COALESCE(NULLIF(applied_amount, 0), NULLIF(current_price, 0), quantity * average_price, 0)
                       ELSE quantity * COALESCE(current_price, average_price) END`;
  try {
    const totals = await pool.query(
      `SELECT COUNT(*)::int AS holdings_count,
              COALESCE(SUM(${invested}), 0)::float8 AS invested_total,
              COALESCE(SUM(${value}), 0)::float8 AS current_total,
              MAX(price_updated_at) AS prices_updated_at
       FROM public.dividend_holdings WHERE user_id = $1 AND is_active`,
      [req.user!.id]
    );
    const group = (column: string) => pool.query(
      `SELECT ${column} AS key, COUNT(*)::int AS holdings_count,
              COALESCE(SUM(${invested}), 0)::float8 AS invested_total,
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
  const payload = normalizeFixedIncomePayload(req.body as Record<string, any>);
  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const autoPrice = d.auto_price ?? d.current_price == null;
  const quantity = d.quantity ?? 1;
  const frequency = d.frequency ?? defaultFrequency(d.asset_type);
  const fiiSegment = resolveFiiSegment(d.asset_type, d.fii_segment);
  try {
    const result = await pool.query(
      `INSERT INTO public.dividend_holdings
         (user_id, ticker, name, asset_type, fii_segment, quantity, dividend_per_share, frequency,
          reference_month, payment_day, is_active, notes, average_price, current_price, auto_price,
          cdi_percent, applied_amount, investment_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::date)
       RETURNING ${columns}`,
      [
        req.user!.id, d.ticker, d.name ?? null, d.asset_type, fiiSegment, quantity,
        d.dividend_per_share, frequency, d.reference_month, d.payment_day, d.is_active, d.notes ?? null,
        d.average_price, d.current_price ?? null, autoPrice,
        d.cdi_percent ?? null, d.applied_amount ?? null, d.investment_date ?? null,
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
  const payload = normalizeFixedIncomePayload(req.body as Record<string, any>);
  const parsed = updateSchema.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados inválidos.', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  try {
    const providedFields = Object.keys(d).filter(key => d[key as keyof typeof d] !== undefined);
    if (providedFields.length === 1 && d.is_active !== undefined) {
      const result = await pool.query(
        `UPDATE public.dividend_holdings
         SET is_active = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2
         RETURNING ${columns}`,
        [id, req.user!.id, d.is_active]
      );
      if (!result.rowCount) {
        res.status(404).json({ error: 'Ativo não encontrado.' });
        return;
      }
      res.json({ data: result.rows[0] });
      return;
    }

    const values: unknown[] = [id, req.user!.id];
    const assignments: string[] = [];
    const assign = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (d.ticker !== undefined) assign('ticker', d.ticker);
    if (Object.hasOwn(d, 'name')) assign('name', d.name ?? null);
    if (d.asset_type !== undefined) assign('asset_type', d.asset_type);
    if (Object.hasOwn(d, 'fii_segment')) {
      assign(
        'fii_segment',
        d.asset_type === undefined ? d.fii_segment ?? null : resolveFiiSegment(d.asset_type, d.fii_segment)
      );
    } else if (d.asset_type !== undefined && !isFiiLike(d.asset_type)) {
      assign('fii_segment', null);
    }
    if (d.quantity !== undefined) assign('quantity', d.quantity);
    if (d.dividend_per_share !== undefined) assign('dividend_per_share', d.dividend_per_share);
    if (d.frequency !== undefined) assign('frequency', d.frequency);
    if (d.reference_month !== undefined) assign('reference_month', d.reference_month);
    if (d.payment_day !== undefined) assign('payment_day', d.payment_day);
    if (d.is_active !== undefined) assign('is_active', d.is_active);
    if (Object.hasOwn(d, 'notes')) assign('notes', d.notes ?? null);
    if (d.average_price !== undefined) assign('average_price', d.average_price);
    if (Object.hasOwn(d, 'current_price')) assign('current_price', d.current_price ?? null);
    if (d.auto_price !== undefined || (d.current_price !== undefined && d.current_price !== null)) {
      assign('auto_price', d.auto_price ?? false);
    }
    if (d.cdi_percent !== undefined) assign('cdi_percent', d.cdi_percent);
    if (d.applied_amount !== undefined) assign('applied_amount', d.applied_amount);
    if (Object.hasOwn(d, 'investment_date')) assign('investment_date', d.investment_date ?? null);

    const result = await pool.query(
      `UPDATE public.dividend_holdings
       SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${columns}`,
      values
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
