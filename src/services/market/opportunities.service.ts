import { pool } from '../../config/database';
import { getBcbMacro } from './bcb.service';
import { analyzeFiiForPortfolio, warmFiiData } from './fii-compare.service';
import { clamp, periodReturn, sma } from './indicators';
import { getBcbMonthlyReturns, getYahooMonthlyLevels, shiftMonth } from './historical-data.service';
import {
  assetClasses, classLabels, computeMetrics, scoreAsset, scoreClass, scoreFixedIncome,
  toRating, type AssetClass, type AssetMetrics, type Macro, type Profile, type Rating, type Scored,
} from './scoring';
import { getPriceHistory, isValidSymbol } from './yahoo-history.service';

type UniverseItem = { ticker: string; symbol: string; assetClass: AssetClass };

const b3 = (assetClass: AssetClass, tickers: string[]): UniverseItem[] =>
  tickers.map(ticker => ({ ticker, symbol: `${ticker}.SA`, assetClass }));
const raw = (assetClass: AssetClass, tickers: string[]): UniverseItem[] =>
  tickers.map(ticker => ({ ticker, symbol: ticker, assetClass }));

const defaultUniverse: UniverseItem[] = [
  ...b3('acoes_br', ['PETR4', 'VALE3', 'ITUB4', 'BBAS3', 'WEGE3', 'BBDC4', 'ABEV3', 'B3SA3', 'RENT3', 'SUZB3', 'PRIO3', 'EQTL3']),
  ...b3('acoes_br', ['BOVA11', 'SMAL11']),
  ...b3('fiis', ['HGLG11', 'XPLG11', 'KNRI11', 'MXRF11', 'XPML11', 'VISC11', 'BTLG11', 'KNCR11', 'HGRU11', 'VGIR11']),
  ...b3('internacional', ['IVVB11']),
  ...raw('internacional', ['VOO', 'QQQ', 'VT']),
  ...raw('cripto', ['BTC-USD', 'ETH-USD']),
];

const macroSymbols = { ibov: '^BVSP', vix: '^VIX', usdBrl: 'BRL=X' } as const;

export const baseAllocation: Record<Profile, Record<AssetClass, number>> = {
  conservador: { renda_fixa: 70, acoes_br: 10, fiis: 15, internacional: 5, cripto: 0 },
  moderado: { renda_fixa: 40, acoes_br: 25, fiis: 20, internacional: 12, cripto: 3 },
  arrojado: { renda_fixa: 20, acoes_br: 35, fiis: 15, internacional: 20, cripto: 10 },
};

const holdingClass: Record<string, AssetClass> = {
  acao: 'acoes_br', etf: 'acoes_br', bdr: 'acoes_br', fii: 'fiis', fiagro: 'fiis',
};

export const disclaimer =
  'Análise quantitativa automática baseada em indicadores históricos de mercado. Não constitui recomendação de investimento personalizada; rentabilidade passada não garante resultados futuros.';

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadMetrics(items: UniverseItem[]) {
  const results = await mapWithConcurrency(items, 5, async item => ({
    item, metrics: computeMetrics(await getPriceHistory(item.symbol)),
  }));
  const loaded: Array<{ item: UniverseItem; metrics: AssetMetrics }> = [];
  const failed: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') loaded.push(result.value);
    else failed.push(items[index].ticker);
  });
  return { loaded, failed };
}

function scoreLongTermEquity(
  levels: Map<string, number>,
  cdi: Map<string, number>,
  currentScore: Scored,
): Scored & { factors: string[]; historyComplete: boolean } {
  const sorted = [...levels].sort(([a], [b]) => a.localeCompare(b));
  const window = sorted.slice(-61);
  if (window.length < 37) {
    return {
      ...currentScore,
      factors: ['Histórico de mercado inferior a 3 anos; análise de longo prazo limitada.'],
      historyComplete: false,
    };
  }

  const continuous = window.every(([key], index) =>
    index === 0 || shiftMonth(window[index - 1][0], 1) === key
  );
  if (!continuous || window.slice(1).some(([key]) => !cdi.has(key))) {
    return {
      ...currentScore,
      factors: ['Histórico mensal incompleto para comparar o ativo com o CDI; análise de longo prazo limitada.'],
      historyComplete: false,
    };
  }

  const returns = window.slice(1).flatMap(([key, value], index) => {
    const previous = window[index][1];
    return previous > 0 && cdi.has(key) ? [{ key, value: value / previous - 1 }] : [];
  });
  if (returns.length < 36) {
    return {
      ...currentScore,
      factors: ['Não há meses suficientes em comum entre o histórico do ativo e o CDI.'],
      historyComplete: false,
    };
  }

  const totalReturn = returns.reduce((total, item) => total * (1 + item.value), 1) - 1;
  const cdiTotal = returns.reduce((total, item) => total * (1 + cdi.get(item.key)!), 1) - 1;
  const years = returns.length / 12;
  const annualizedReturn = (1 + totalReturn) ** (1 / years) - 1;
  const annualizedCdi = (1 + cdiTotal) ** (1 / years) - 1;
  const average = returns.reduce((sum, item) => sum + item.value, 0) / returns.length;
  const volatility = returns.length > 1
    ? Math.sqrt(returns.reduce((sum, item) => sum + (item.value - average) ** 2, 0) / (returns.length - 1)) * Math.sqrt(12)
    : 0;

  let level = 1;
  let peak = 1;
  let maxDrawdown = 0;
  returns.forEach(item => {
    level *= 1 + item.value;
    peak = Math.max(peak, level);
    maxDrawdown = Math.min(maxDrawdown, level / peak - 1);
  });

  const longTermScore = 50
    + clamp((annualizedReturn - annualizedCdi) / 0.1, -1, 1) * 25
    + clamp((0.25 - Math.abs(maxDrawdown)) / 0.25, -1, 1) * 15
    + clamp((0.3 - volatility) / 0.3, -1, 1) * 10;
  const score = Math.round(currentScore.score * 0.4 + longTermScore * 0.6);
  const pctLabel = (value: number) => `${(value * 100).toFixed(1).replace('.', ',')}%`;
  const factors = [
    `Retorno total anualizado em ${years.toFixed(1).replace('.', ',')} anos: ${pctLabel(annualizedReturn)}; CDI no mesmo período: ${pctLabel(annualizedCdi)}.`,
    `Volatilidade anualizada no período: ${pctLabel(volatility)}.`,
    `Queda máxima observada no período: ${pctLabel(maxDrawdown)}.`,
    'Série de preços ajustados por proventos; não avalia lucro, dívida, ROE ou valuation fundamentalista da empresa.',
  ];
  return {
    ...currentScore,
    score,
    rating: toRating(score),
    rating_label: ratingLabel(toRating(score)),
    reasons: [...currentScore.reasons, ...factors.slice(0, 3)],
    factors,
    historyComplete: true,
  };
}

const ratingLabels: Record<Rating, string> = {
  otimo: 'Ótimo', bom: 'Bom', neutro: 'Neutro', atencao: 'Atenção', evitar: 'Evitar',
};

function ratingLabel(rating: Rating): string {
  return ratingLabels[rating];
}

async function analyzeEquityHistory(asset: {
  ticker: string;
  score: number;
  rating: Rating;
  rating_label: string;
  reasons: string[];
}) {
  const [levels, cdi] = await Promise.all([
    getYahooMonthlyLevels(`${asset.ticker}.SA`),
    getBcbMonthlyReturns(4391),
  ]);
  return scoreLongTermEquity(levels, cdi, {
    score: asset.score,
    rating: asset.rating,
    rating_label: asset.rating_label,
    reasons: asset.reasons,
  });
}

export async function getMacro(): Promise<{ macro: Macro; warnings: string[] }> {
  const warnings: string[] = [];
  const macro: Macro = {};

  const [bcb, ibov, vix, usdBrl] = await Promise.allSettled([
    getBcbMacro(),
    getPriceHistory(macroSymbols.ibov),
    getPriceHistory(macroSymbols.vix),
    getPriceHistory(macroSymbols.usdBrl),
  ]);

  if (bcb.status === 'fulfilled') Object.assign(macro, bcb.value);
  else warnings.push('Indicadores do Banco Central (Selic/CDI/IPCA) indisponíveis.');

  if (ibov.status === 'fulfilled') {
    const average = sma(ibov.value.closes, Math.min(200, ibov.value.closes.length));
    if (average) macro.ibovVsSma200 = ibov.value.closes[ibov.value.closes.length - 1] / average - 1;
  } else warnings.push('Histórico do Ibovespa indisponível.');

  if (vix.status === 'fulfilled') macro.vix = vix.value.closes[vix.value.closes.length - 1];
  else warnings.push('VIX indisponível.');

  if (usdBrl.status === 'fulfilled') macro.usdBrlMomentum3m = periodReturn(usdBrl.value.closes, 63);

  return { macro, warnings };
}

function suggestAllocation(profile: Profile, classScores: Partial<Record<AssetClass, number>>) {
  const weights = assetClasses.map(assetClass => {
    const score = classScores[assetClass];
    return { assetClass, weight: baseAllocation[profile][assetClass] * (score === undefined ? 1 : 0.5 + score / 100) };
  });
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  const result = Object.fromEntries(
    weights.map(item => [item.assetClass, Math.round((item.weight / total) * 100)])
  ) as Record<AssetClass, number>;

  const diff = 100 - Object.values(result).reduce((sum, value) => sum + value, 0);
  const largest = (Object.keys(result) as AssetClass[]).sort((a, b) => result[b] - result[a])[0];
  result[largest] += diff;
  return result;
}

async function loadUserHoldings(userId: number | string): Promise<UniverseItem[]> {
  const result = await pool.query(
    `SELECT DISTINCT ticker, asset_type FROM public.dividend_holdings
     WHERE user_id = $1 AND is_active = TRUE AND asset_type = ANY($2)`,
    [userId, Object.keys(holdingClass)]
  );
  return result.rows
    .map((row: { ticker: string; asset_type: string }) => {
      const ticker = row.ticker.trim().toUpperCase();
      return { ticker, symbol: `${ticker}.SA`, assetClass: holdingClass[row.asset_type] };
    })
    .filter((item: UniverseItem) => /^[A-Z0-9]{4,7}$/.test(item.ticker) && isValidSymbol(item.symbol));
}

export async function getOpportunities(profile: Profile, userId?: number | string) {
  const { macro, warnings } = await getMacro();

  const holdings = userId === undefined ? [] : await loadUserHoldings(userId);
  const universe = [...defaultUniverse];
  holdings.forEach(item => {
    if (!universe.some(existing => existing.symbol === item.symbol)) universe.push(item);
  });

  const { loaded, failed } = await loadMetrics(universe);
  if (failed.length) warnings.push(`Sem dados de mercado para: ${failed.join(', ')}.`);

  const assets = loaded.map(({ item, metrics }) => ({
    ticker: item.ticker,
    asset_class: item.assetClass,
    price: Number(metrics.price.toFixed(2)),
    in_portfolio: holdings.some(holding => holding.symbol === item.symbol),
    ...scoreAsset(metrics, item.assetClass, profile),
  }));

  const equities = assets.filter(asset => asset.asset_class === 'acoes_br');
  const equityResults = await mapWithConcurrency(equities, 4, asset => analyzeEquityHistory(asset));
  const equityAnalysis = new Map<string, ReturnType<typeof scoreLongTermEquity>>();
  equityResults.forEach((result, index) => {
    if (result.status === 'fulfilled') equityAnalysis.set(equities[index].ticker, result.value);
    else warnings.push(`Histórico de longo prazo indisponível para ${equities[index].ticker}; nota baseada nos indicadores de curto prazo.`);
  });

  const fiis = assets.filter(asset => asset.asset_class === 'fiis');
  const fiiResults = await mapWithConcurrency(fiis, 3, asset => analyzeFiiForPortfolio(asset.ticker, 5));
  const fiiAnalysis = new Map<string, Awaited<ReturnType<typeof analyzeFiiForPortfolio>>>();
  fiiResults.forEach((result, index) => {
    if (result.status === 'fulfilled') fiiAnalysis.set(fiis[index].ticker, result.value);
    else warnings.push(`Análise completa indisponível para ${fiis[index].ticker}; nota baseada nos indicadores de curto prazo.`);
  });

  const enrichedAssets = assets.map(asset => {
    const equity = equityAnalysis.get(asset.ticker);
    if (equity) {
      return {
        ...asset,
        ...equity,
        analysis_factors: equity.factors,
        analysis_type: equity.historyComplete ? 'equity_market_history' as const : 'short_term_market' as const,
      };
    }
    const fii = fiiAnalysis.get(asset.ticker);
    if (fii) {
      const { fund, scored, stats, windowMonths } = fii;
      const percent = (value: number | null | undefined) =>
        value == null ? 'indisponível' : `${value.toFixed(1).replace('.', ',')}%`;
      const percentagePoints = (value: number | null | undefined) =>
        value == null ? 'indisponível' : `${value > 0 ? '+' : ''}${value.toFixed(1).replace('.', ',')} p.p.`;
      const factors = [
        ...scored.reasons,
        `Valor patrimonial por cota: R$ ${fund.market.vp_per_share.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
        `Cotação atual: R$ ${fund.market.price.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
        `Janela histórica: ${(windowMonths / 12).toFixed(1).replace('.', ',')} anos; retorno anualizado ${percent(stats?.total_cagr_pct)}; diferença para o CDI ${percentagePoints(stats?.excess_over_cdi_pp)}; queda máxima ${percent(stats?.max_drawdown_pct)}.`,
        'Vacância: não disponível nos dados padronizados consultados; não foi estimada nem pontuada.',
      ];
      return {
        ...asset,
        score: scored.score,
        rating: scored.rating,
        rating_label: scored.rating_label,
        reasons: factors,
        analysis_factors: factors,
        analysis_type: 'fii_fundamentals' as const,
      };
    }
    return {
      ...asset,
      analysis_type: 'short_term_market' as const,
    };
  });

  const classes: Array<{ id: AssetClass; label: string; top_assets: string[] } & Scored> = [
    { id: 'renda_fixa' as AssetClass, label: classLabels.renda_fixa, top_assets: ['Tesouro Selic', 'CDB 100%+ do CDI', 'LCI/LCA'], ...scoreFixedIncome(macro, profile) },
    ...assetClasses.filter(id => id !== 'renda_fixa').map(id => {
      const inClass = enrichedAssets.filter(asset => asset.asset_class === id).sort((a, b) => b.score - a.score);
      return {
        id,
        label: classLabels[id],
        top_assets: inClass.slice(0, 3).map(asset => asset.ticker),
        ...scoreClass(inClass.map(asset => asset.score), id, macro, profile),
      };
    }),
  ].sort((a, b) => b.score - a.score);

  const ranking = [...enrichedAssets].sort((a, b) => b.score - a.score);
  const classScores = Object.fromEntries(classes.map(item => [item.id, item.score])) as Partial<Record<AssetClass, number>>;

  return {
    generated_at: new Date().toISOString(),
    profile,
    macro: {
      selic: macro.selic ?? null,
      cdi: macro.cdi ?? null,
      ipca_12m: macro.ipca12m ?? null,
      real_rate: macro.realRate === undefined ? null : Number(macro.realRate.toFixed(2)),
      ibov_vs_sma200: macro.ibovVsSma200 === undefined ? null : Number(macro.ibovVsSma200.toFixed(4)),
      vix: macro.vix === undefined ? null : Number(macro.vix.toFixed(2)),
      usd_brl_momentum_3m: macro.usdBrlMomentum3m === undefined ? null : Number(macro.usdBrlMomentum3m.toFixed(4)),
    },
    best_class: classes[0],
    classes,
    ranking: ranking.slice(0, 15),
    portfolio: ranking.filter(asset => asset.in_portfolio),
    avoid: ranking.filter(asset => asset.rating === 'evitar' || asset.rating === 'atencao').slice(-5).reverse(),
    suggested_allocation_pct: suggestAllocation(profile, classScores),
    warnings,
    disclaimer,
  };
}

export async function getAssetAnalysis(ticker: string, assetClass: AssetClass, profile: Profile) {
  const symbol = assetClass === 'cripto' && !ticker.includes('-') ? `${ticker}-USD`
    : assetClass === 'acoes_br' || assetClass === 'fiis' ? `${ticker}.SA` : ticker;
  if (!isValidSymbol(symbol)) throw new Error('Ticker inválido.');

  const metrics = computeMetrics(await getPriceHistory(symbol));
  return {
    ticker,
    symbol,
    asset_class: assetClass,
    price: Number(metrics.price.toFixed(2)),
    ...scoreAsset(metrics, assetClass, profile),
    disclaimer,
  };
}

// Aquece os caches de mercado para que as requisições respondam sem esperar fontes externas.
export async function refreshMarketData() {
  await getMacro();
  await loadMetrics(defaultUniverse);
  await warmFiiData();
}

export function startMarketRefresh(intervalMs = 60 * 60 * 1000) {
  const run = () => refreshMarketData().catch(error => console.error('Falha ao atualizar dados de mercado:', error));
  void run();
  setInterval(run, intervalMs).unref();
}
