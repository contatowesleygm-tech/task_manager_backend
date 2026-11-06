import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';
import { getUsdToBrlRate } from '../services/exchange-rate.service';

const accountTypes = ['conta_corrente', 'poupanca', 'investimento', 'dinheiro', 'outro'] as const;
const currencies = ['BRL', 'USD'] as const;
const assetTypes = ['carro', 'moto', 'imovel', 'outro'] as const;
const ownershipStatuses = ['proprio', 'financiado', 'alugado', 'alugado_para_terceiros', 'outro'] as const;
const liabilityTypes = ['financiamento', 'cartao_credito', 'emprestimo', 'aluguel', 'conta', 'outro'] as const;
const maxMoney = 999999999999.99;

const createAccountSchema = z.object({
  institution: z.string().trim().min(1).max(120),
  account_name: z.string().trim().min(1).max(120),
  account_type: z.enum(accountTypes).default('conta_corrente'),
  currency: z.enum(currencies).default('BRL'),
  balance: z.number().finite().min(-maxMoney).max(maxMoney).default(0),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const updateAccountSchema = z.object({
  institution: z.string().trim().min(1).max(120).optional(),
  account_name: z.string().trim().min(1).max(120).optional(),
  account_type: z.enum(accountTypes).optional(),
  currency: z.enum(currencies).optional(),
  balance: z.number().finite().min(-maxMoney).max(maxMoney).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'Informe ao menos um campo para atualizar.',
});

const createAssetSchema = z.object({
  name: z.string().trim().min(1).max(160),
  asset_type: z.enum(assetTypes),
  estimated_value: z.number().finite().min(0).max(maxMoney).default(0),
  currency: z.enum(currencies).default('BRL'),
  ownership_status: z.enum(ownershipStatuses).default('proprio'),
  monthly_rent: z.number().finite().min(0).max(maxMoney).default(0),
  include_in_patrimony: z.boolean().default(true),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const updateAssetSchema = createAssetSchema.partial().refine(data => Object.keys(data).length > 0, {
  message: 'Informe ao menos um campo para atualizar.',
});

const createLiabilitySchema = z.object({
  name: z.string().trim().min(1).max(160),
  liability_type: z.enum(liabilityTypes).default('outro'),
  original_amount: z.number().finite().min(0).max(maxMoney).default(0),
  outstanding_balance: z.number().finite().min(0).max(maxMoney),
  currency: z.enum(currencies).default('BRL'),
  monthly_payment: z.number().finite().min(0).max(maxMoney).default(0),
  due_date: z.string().date().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const updateLiabilitySchema = createLiabilitySchema.partial().refine(data => Object.keys(data).length > 0, {
  message: 'Informe ao menos um campo para atualizar.',
});

function parseId(value: string | string[]): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function presentAccounts(rows: Array<Record<string, any>>) {
  const hasUsd = rows.some(row => row.currency === 'USD');
  const exchangeRate = hasUsd ? await getUsdToBrlRate() : undefined;
  return {
    data: rows.map(row => {
      const balance = Number(row.balance);
      return {
        ...row,
        balance,
        balance_brl: row.currency === 'USD'
          ? Number((balance * exchangeRate!.rate).toFixed(2))
          : balance,
      };
    }),
    currency: 'BRL',
    ...(exchangeRate ? {
      usd_to_brl_rate: exchangeRate.rate,
      exchange_rate_date: exchangeRate.date,
    } : {}),
  };
}

export async function getFinanceSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const [accountsResult, assetsResult, liabilitiesResult, portfolioResult] = await Promise.all([pool.query(
      `SELECT COALESCE(SUM(balance) FILTER (WHERE currency = 'BRL' AND is_active), 0)::text AS brl_total,
              COALESCE(SUM(balance) FILTER (WHERE currency = 'USD' AND is_active), 0)::text AS usd_total,
              BOOL_OR(currency = 'USD' AND is_active) AS has_usd,
              COUNT(*)::int AS accounts_count,
              COUNT(*) FILTER (WHERE account_type = 'investimento')::int AS investments_count
       FROM public.financial_accounts
       WHERE user_id = $1`,
      [req.user!.id]
    ), pool.query(
      `SELECT
         COALESCE(SUM(estimated_value) FILTER (WHERE currency = 'BRL' AND include_in_patrimony), 0)::text AS brl_total,
         COALESCE(SUM(estimated_value) FILTER (WHERE currency = 'USD' AND include_in_patrimony), 0)::text AS usd_total,
         COALESCE(SUM(monthly_rent) FILTER (WHERE currency = 'BRL'), 0)::text AS brl_monthly_rent,
         COALESCE(SUM(monthly_rent) FILTER (WHERE currency = 'USD'), 0)::text AS usd_monthly_rent,
         BOOL_OR(currency = 'USD') AS has_usd,
         COUNT(*)::int AS assets_count,
         COUNT(*) FILTER (WHERE asset_type = 'imovel')::int AS properties_count
       FROM public.financial_assets
       WHERE user_id = $1`,
      [req.user!.id]
    ), pool.query(
      `SELECT
         COALESCE(SUM(outstanding_balance) FILTER (WHERE currency = 'BRL'), 0)::text AS brl_total,
         COALESCE(SUM(outstanding_balance) FILTER (WHERE currency = 'USD'), 0)::text AS usd_total,
         COALESCE(SUM(monthly_payment) FILTER (WHERE currency = 'BRL'), 0)::text AS brl_monthly_payment,
         COALESCE(SUM(monthly_payment) FILTER (WHERE currency = 'USD'), 0)::text AS usd_monthly_payment,
         BOOL_OR(currency = 'USD') AS has_usd,
         COUNT(*)::int AS liabilities_count
       FROM public.financial_liabilities
       WHERE user_id = $1`,
      [req.user!.id]
    ), pool.query(
      `SELECT COALESCE(SUM(
                CASE WHEN asset_type = 'renda_fixa' THEN COALESCE(NULLIF(applied_amount, 0), quantity * average_price, 0)
                     ELSE quantity * average_price END
              ), 0)::float8 AS invested_total,
              COALESCE(SUM(
                CASE WHEN asset_type = 'renda_fixa' THEN COALESCE(NULLIF(applied_amount, 0), NULLIF(current_price, 0), quantity * average_price, 0)
                     ELSE quantity * COALESCE(current_price, average_price) END
              ) FILTER (WHERE is_active), 0)::float8 AS active_current_total,
              COALESCE(SUM(
                CASE WHEN asset_type = 'renda_fixa' THEN COALESCE(NULLIF(applied_amount, 0), NULLIF(current_price, 0), quantity * average_price, 0)
                     ELSE quantity * COALESCE(current_price, average_price) END
              ), 0)::float8 AS all_current_total
       FROM public.dividend_holdings
       WHERE user_id = $1`,
      [req.user!.id]
    )]);
    const row = accountsResult.rows[0];
    const assets = assetsResult.rows[0];
    const liabilities = liabilitiesResult.rows[0];
    const portfolio = portfolioResult.rows[0];
    const hasUsd = Boolean(row.has_usd || assets.has_usd || liabilities.has_usd);
    const exchangeRate = hasUsd ? await getUsdToBrlRate() : undefined;
    const usdAccountTotal = Number(row.usd_total);
    const usdAssetTotal = Number(assets.usd_total);
    const usdLiabilityTotal = Number(liabilities.usd_total);
    const registeredAssetsTotalBrl = Number(assets.brl_total)
      + (exchangeRate ? usdAssetTotal * exchangeRate.rate : 0);
    const accountBalancesBrl = Number(row.brl_total)
      + (exchangeRate ? usdAccountTotal * exchangeRate.rate : 0);
    const investmentPortfolioBrl = Number(portfolio.all_current_total);
    const activeInvestmentPortfolioBrl = Number(portfolio.active_current_total);
    const assetsTotalBrl = accountBalancesBrl + registeredAssetsTotalBrl + investmentPortfolioBrl;
    const liabilitiesTotalBrl = Number(liabilities.brl_total)
      + (exchangeRate ? usdLiabilityTotal * exchangeRate.rate : 0);
    const netWorthBrl = assetsTotalBrl - liabilitiesTotalBrl;
    const monthlyRentTotal = Number(assets.brl_monthly_rent)
      + (exchangeRate ? Number(assets.usd_monthly_rent) * exchangeRate.rate : 0);
    const monthlyPaymentsTotal = Number(liabilities.brl_monthly_payment)
      + (exchangeRate ? Number(liabilities.usd_monthly_payment) * exchangeRate.rate : 0);
    res.json({
      data: {
        total_patrimony: Number(netWorthBrl.toFixed(2)),
        net_worth_brl: Number(netWorthBrl.toFixed(2)),
        account_balances_brl: Number(accountBalancesBrl.toFixed(2)),
        brl_total: Number(row.brl_total),
        usd_total: usdAccountTotal,
        currency: 'BRL',
        accounts_count: row.accounts_count,
        investments_count: row.investments_count,
        assets_count: assets.assets_count,
        properties_count: assets.properties_count,
        registered_assets_total_brl: Number(registeredAssetsTotalBrl.toFixed(2)),
        investment_portfolio_invested_brl: Number(Number(portfolio.invested_total).toFixed(2)),
        investment_portfolio_value_brl: Number(activeInvestmentPortfolioBrl.toFixed(2)),
        investment_portfolio_total_value_brl: Number(investmentPortfolioBrl.toFixed(2)),
        investment_portfolio_profit_loss_brl: Number((investmentPortfolioBrl - Number(portfolio.invested_total)).toFixed(2)),
        assets_total_brl: Number(assetsTotalBrl.toFixed(2)),
        liabilities_count: liabilities.liabilities_count,
        liabilities_total_brl: Number(liabilitiesTotalBrl.toFixed(2)),
        monthly_liability_payments_brl: Number(monthlyPaymentsTotal.toFixed(2)),
        monthly_rent_brl: Number(monthlyRentTotal.toFixed(2)),
        ...(exchangeRate ? {
          usd_to_brl_rate: exchangeRate.rate,
          exchange_rate_date: exchangeRate.date,
        } : {}),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function listFinancialAccounts(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pool.query(
      `SELECT id, institution, account_name, account_type, balance::numeric(14, 2)::text AS balance,
              currency,
              is_active, notes, created_at, updated_at
       FROM public.financial_accounts
       WHERE user_id = $1
       ORDER BY institution, account_name, id`,
      [req.user!.id]
    );
    res.json(await presentAccounts(result.rows));
  } catch (error) {
    next(error);
  }
}

export async function createFinancialAccount(req: Request, res: Response, next: NextFunction) {
  const parsed = createAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados da conta inválidos.', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO public.financial_accounts
         (user_id, institution, account_name, account_type, balance, currency, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, institution, account_name, account_type, balance::numeric(14, 2)::text AS balance,
                 currency,
                 is_active, notes, created_at, updated_at`,
      [req.user!.id, data.institution, data.account_name, data.account_type, data.balance, data.currency, data.notes ?? null]
    );
    const presented = await presentAccounts(result.rows);
    res.status(201).json({ ...presented, data: presented.data[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateFinancialAccount(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID da conta inválido.' });
    return;
  }
  const parsed = updateAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados da conta inválidos.', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  try {
    const result = await pool.query(
      `UPDATE public.financial_accounts
       SET institution = COALESCE($3, institution),
           account_name = COALESCE($4, account_name),
           account_type = COALESCE($5, account_type),
           balance = COALESCE($6, balance),
           currency = COALESCE($7, currency),
           notes = CASE WHEN $8::boolean THEN $9::text ELSE notes END,
           is_active = COALESCE($10, is_active),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id, institution, account_name, account_type, balance::numeric(14, 2)::text AS balance,
                 currency,
                 is_active, notes, created_at, updated_at`,
      [
        id, req.user!.id, data.institution ?? null, data.account_name ?? null,
        data.account_type ?? null, data.balance ?? null, data.currency ?? null,
        Object.hasOwn(data, 'notes'), data.notes ?? null, data.is_active ?? null,
      ]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Conta financeira não encontrada.' });
      return;
    }
    const presented = await presentAccounts(result.rows);
    res.json({ ...presented, data: presented.data[0] });
  } catch (error) {
    next(error);
  }
}

export async function deleteFinancialAccount(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID da conta inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      'DELETE FROM public.financial_accounts WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Conta financeira não encontrada.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

async function presentAssets(rows: Array<Record<string, any>>) {
  const hasUsd = rows.some(row => row.currency === 'USD');
  const exchangeRate = hasUsd ? await getUsdToBrlRate() : undefined;
  return {
    data: rows.map(row => {
      const estimatedValue = Number(row.estimated_value);
      const monthlyRent = Number(row.monthly_rent);
      const conversion = row.currency === 'USD' ? exchangeRate!.rate : 1;
      return {
        ...row,
        estimated_value: estimatedValue,
        monthly_rent: monthlyRent,
        estimated_value_brl: Number((estimatedValue * conversion).toFixed(2)),
        net_value_brl: row.include_in_patrimony
          ? Number((estimatedValue * conversion).toFixed(2))
          : 0,
        monthly_rent_brl: Number((monthlyRent * conversion).toFixed(2)),
      };
    }),
    currency: 'BRL',
    ...(exchangeRate ? {
      usd_to_brl_rate: exchangeRate.rate,
      exchange_rate_date: exchangeRate.date,
    } : {}),
  };
}

const assetReturning = `id, name, asset_type,
  estimated_value::numeric(14, 2)::text AS estimated_value,
  currency, ownership_status,
  monthly_rent::numeric(14, 2)::text AS monthly_rent,
  include_in_patrimony, notes, created_at, updated_at`;

export async function listFinancialAssets(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pool.query(
      `SELECT ${assetReturning}
       FROM public.financial_assets
       WHERE user_id = $1
       ORDER BY asset_type, name, id`,
      [req.user!.id]
    );
    res.json(await presentAssets(result.rows));
  } catch (error) {
    next(error);
  }
}

export async function createFinancialAsset(req: Request, res: Response, next: NextFunction) {
  if (Object.hasOwn(req.body ?? {}, 'outstanding_debt')) {
    res.status(400).json({ error: 'Cadastre dívidas separadamente em /api/finances/liabilities.' });
    return;
  }
  const parsed = createAssetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados do bem inválidos.', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO public.financial_assets
         (user_id, name, asset_type, estimated_value, currency,
          ownership_status, monthly_rent, include_in_patrimony, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${assetReturning}`,
      [req.user!.id, data.name, data.asset_type, data.estimated_value,
        data.currency, data.ownership_status, data.monthly_rent, data.include_in_patrimony,
        data.notes ?? null]
    );
    const presented = await presentAssets(result.rows);
    res.status(201).json({ ...presented, data: presented.data[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateFinancialAsset(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do bem inválido.' });
    return;
  }
  if (Object.hasOwn(req.body ?? {}, 'outstanding_debt')) {
    res.status(400).json({ error: 'Cadastre dívidas separadamente em /api/finances/liabilities.' });
    return;
  }
  const parsed = updateAssetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados do bem inválidos.', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  try {
    const result = await pool.query(
      `UPDATE public.financial_assets
       SET name = COALESCE($3, name),
           asset_type = COALESCE($4, asset_type),
           estimated_value = COALESCE($5, estimated_value),
           currency = COALESCE($6, currency),
           ownership_status = COALESCE($7, ownership_status),
           monthly_rent = COALESCE($8, monthly_rent),
           include_in_patrimony = COALESCE($9, include_in_patrimony),
           notes = CASE WHEN $10::boolean THEN $11::text ELSE notes END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${assetReturning}`,
      [id, req.user!.id, data.name ?? null, data.asset_type ?? null,
        data.estimated_value ?? null, data.currency ?? null, data.ownership_status ?? null,
        data.monthly_rent ?? null, data.include_in_patrimony ?? null,
        Object.hasOwn(data, 'notes'), data.notes ?? null]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Bem financeiro não encontrado.' });
      return;
    }
    const presented = await presentAssets(result.rows);
    res.json({ ...presented, data: presented.data[0] });
  } catch (error) {
    next(error);
  }
}

export async function deleteFinancialAsset(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do bem inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      'DELETE FROM public.financial_assets WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Bem financeiro não encontrado.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

const liabilityReturning = `id, source_asset_id, name, liability_type,
  original_amount::numeric(14, 2)::text AS original_amount,
  outstanding_balance::numeric(14, 2)::text AS outstanding_balance,
  currency, monthly_payment::numeric(14, 2)::text AS monthly_payment,
  due_date, notes, created_at, updated_at`;

async function presentLiabilities(rows: Array<Record<string, any>>) {
  const hasUsd = rows.some(row => row.currency === 'USD');
  const exchangeRate = hasUsd ? await getUsdToBrlRate() : undefined;
  return {
    data: rows.map(row => {
      const conversion = row.currency === 'USD' ? exchangeRate!.rate : 1;
      const balance = Number(row.outstanding_balance);
      return {
        ...row,
        original_amount: Number(row.original_amount),
        outstanding_balance: balance,
        monthly_payment: Number(row.monthly_payment),
        outstanding_balance_brl: Number((balance * conversion).toFixed(2)),
        monthly_payment_brl: Number((Number(row.monthly_payment) * conversion).toFixed(2)),
      };
    }),
    currency: 'BRL',
    ...(exchangeRate ? {
      usd_to_brl_rate: exchangeRate.rate,
      exchange_rate_date: exchangeRate.date,
    } : {}),
  };
}

export async function listFinancialLiabilities(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pool.query(
      `SELECT ${liabilityReturning}
       FROM public.financial_liabilities
       WHERE user_id = $1
       ORDER BY due_date NULLS LAST, name, id`,
      [req.user!.id]
    );
    res.json(await presentLiabilities(result.rows));
  } catch (error) {
    next(error);
  }
}

export async function createFinancialLiability(req: Request, res: Response, next: NextFunction) {
  const parsed = createLiabilitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados do passivo inválidos.', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO public.financial_liabilities
         (user_id, name, liability_type, original_amount, outstanding_balance,
          currency, monthly_payment, due_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)
       RETURNING ${liabilityReturning}`,
      [req.user!.id, data.name, data.liability_type, data.original_amount,
        data.outstanding_balance, data.currency, data.monthly_payment,
        data.due_date ?? null, data.notes ?? null]
    );
    const presented = await presentLiabilities(result.rows);
    res.status(201).json({ ...presented, data: presented.data[0] });
  } catch (error) {
    next(error);
  }
}

export async function updateFinancialLiability(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do passivo inválido.' });
    return;
  }
  const parsed = updateLiabilitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Dados do passivo inválidos.', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  try {
    const result = await pool.query(
      `UPDATE public.financial_liabilities
       SET name = COALESCE($3, name),
           liability_type = COALESCE($4, liability_type),
           original_amount = COALESCE($5, original_amount),
           outstanding_balance = COALESCE($6, outstanding_balance),
           currency = COALESCE($7, currency),
           monthly_payment = COALESCE($8, monthly_payment),
           due_date = CASE WHEN $9::boolean THEN $10::date ELSE due_date END,
           notes = CASE WHEN $11::boolean THEN $12::text ELSE notes END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${liabilityReturning}`,
      [id, req.user!.id, data.name ?? null, data.liability_type ?? null,
        data.original_amount ?? null, data.outstanding_balance ?? null, data.currency ?? null,
        data.monthly_payment ?? null, Object.hasOwn(data, 'due_date'), data.due_date ?? null,
        Object.hasOwn(data, 'notes'), data.notes ?? null]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Passivo financeiro não encontrado.' });
      return;
    }
    const presented = await presentLiabilities(result.rows);
    res.json({ ...presented, data: presented.data[0] });
  } catch (error) {
    next(error);
  }
}

export async function deleteFinancialLiability(req: Request, res: Response, next: NextFunction) {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'ID do passivo inválido.' });
    return;
  }
  try {
    const result = await pool.query(
      'DELETE FROM public.financial_liabilities WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user!.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Passivo financeiro não encontrado.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
