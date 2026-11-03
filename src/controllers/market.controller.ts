import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getAssetAnalysis, getMacro, getOpportunities } from '../services/market/opportunities.service';
import { assetClasses, profiles } from '../services/market/scoring';

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
