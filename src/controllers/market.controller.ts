import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { BacktestInputError, earliestStartYear, getBacktest } from '../services/market/backtest.service';
import { compareFiis, defaultFiiTickers, FiiInputError } from '../services/market/fii-compare.service';
import { getAssetAnalysis, getMacro, getOpportunities } from '../services/market/opportunities.service';
import { assetClasses, profiles } from '../services/market/scoring';

const fiiQuery = z.object({
  tickers: z.string().max(200).optional(),
  anos: z.coerce.number().int().min(1).max(10).default(5),
  valor: z.coerce.number().positive().max(10_000_000_000).default(10000),
});

const backtestQuery = z.object({
  valor: z.coerce.number().positive().max(10_000_000_000),
  ano_inicial: z.coerce.number().int().optional(),
  anos: z.coerce.number().int().min(1).max(30).optional(),
  aporte_mensal: z.coerce.number().min(0).max(1_000_000_000).default(0),
  reajustar_aporte_ipca: z.enum(['true', 'false']).default('false'),
  perfil: z.enum(profiles).default('moderado'),
  carteira: z.string().max(200).optional(),
  ativos: z.string().max(200).optional(),
});

// Formato: "cdi:40,ibovespa:30,sp500:30"
function parseWeights(value: string): Record<string, number> | undefined {
  const entries = value.split(',').map(part => part.trim().split(':'));
  if (entries.some(([id, weight]) => !/^[a-z0-9_]+$/.test(id ?? '') || !(Number(weight) > 0))) return undefined;
  return Object.fromEntries(entries.map(([id, weight]) => [id, Number(weight)]));
}

const opportunitiesQuery = z.object({
  perfil: z.enum(profiles).default('moderado'),
  carteira: z.enum(['true', 'false']).default('true'),
});

const assetParams = z.object({
  ticker: z.string().trim().toUpperCase().regex(/^[A-Z0-9.=^-]{1,20}$/),
});

const assetQuery = z.object({
  classe: z.enum(assetClasses.filter(item => item !== 'renda_fixa') as [string, ...string[]]).default('acoes_br'),
  perfil: z.enum(profiles).default('moderado'),
});

export async function listOpportunities(req: Request, res: Response, next: NextFunction) {
  const query = opportunitiesQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'Parâmetros inválidos', details: query.error.flatten() });
    return;
  }
  try {
    res.json(await getOpportunities(query.data.perfil, query.data.carteira === 'true' ? req.user!.id : undefined));
  } catch (error) {
    next(error);
  }
}

export async function compareMarketFiis(req: Request, res: Response, next: NextFunction) {
  const query = fiiQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'Parâmetros inválidos', details: query.error.flatten() });
    return;
  }
  const tickers = query.data.tickers
    ? [...new Set(query.data.tickers.split(',').map(item => item.trim().toUpperCase()).filter(Boolean))]
    : defaultFiiTickers;
  if (tickers.length > 12 || tickers.some(ticker => !/^[A-Z]{4}1[0-9]$/.test(ticker))) {
    res.status(400).json({ error: 'Informe de 1 a 12 tickers de FIIs válidos, por exemplo HGLG11,KNRI11' });
    return;
  }

  try {
    res.json(await compareFiis(tickers, query.data.anos, query.data.valor));
  } catch (error) {
    if (error instanceof FiiInputError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error) {
      res.status(502).json({ error: error.message });
      return;
    }
    next(error);
  }
}

export async function runMarketBacktest(req: Request, res: Response, next: NextFunction) {
  const query = backtestQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'Parâmetros inválidos', details: query.error.flatten() });
    return;
  }
  const data = query.data;
  const currentYear = new Date().getFullYear();
  const startYear = data.ano_inicial ?? currentYear - (data.anos ?? 10);
  if (startYear < earliestStartYear || startYear >= currentYear) {
    res.status(400).json({ error: `ano_inicial deve estar entre ${earliestStartYear} e ${currentYear - 1}` });
    return;
  }
  const portfolio = data.carteira ? parseWeights(data.carteira) : undefined;
  if (data.carteira && !portfolio) {
    res.status(400).json({ error: 'carteira inválida. Use o formato cdi:40,ibovespa:30,sp500:30' });
    return;
  }

  try {
    res.json(await getBacktest({
      initialAmount: data.valor,
      startYear,
      monthlyContribution: data.aporte_mensal,
      indexContributionToInflation: data.reajustar_aporte_ipca === 'true',
      profile: data.perfil,
      portfolio,
      assetFilter: data.ativos?.split(',').map(item => item.trim()).filter(Boolean),
    }));
  } catch (error) {
    if (error instanceof BacktestInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof Error) {
      res.status(502).json({ error: error.message });
      return;
    }
    next(error);
  }
}

export async function getMarketMacro(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getMacro());
  } catch (error) {
    next(error);
  }
}

export async function getMarketAsset(req: Request, res: Response, next: NextFunction) {
  const params = assetParams.safeParse(req.params);
  const query = assetQuery.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: 'Parâmetros inválidos' });
    return;
  }
  try {
    res.json(await getAssetAnalysis(
      params.data.ticker, query.data.classe as (typeof assetClasses)[number], query.data.perfil
    ));
  } catch (error) {
    if (error instanceof Error) {
      res.status(502).json({ error: error.message });
      return;
    }
    next(error);
  }
}
