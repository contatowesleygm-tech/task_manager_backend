import { pool } from '../../config/database';
import { getBcbMacro } from './bcb.service';
import { periodReturn, sma } from './indicators';
import {
  assetClasses, classLabels, computeMetrics, scoreAsset, scoreClass, scoreFixedIncome,
  type AssetClass, type AssetMetrics, type Macro, type Profile, type Scored,
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

const baseAllocation: Record<Profile, Record<AssetClass, number>> = {
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

  const classes: Array<{ id: AssetClass; label: string; top_assets: string[] } & Scored> = [
    { id: 'renda_fixa' as AssetClass, label: classLabels.renda_fixa, top_assets: ['Tesouro Selic', 'CDB 100%+ do CDI', 'LCI/LCA'], ...scoreFixedIncome(macro, profile) },
    ...assetClasses.filter(id => id !== 'renda_fixa').map(id => {
      const inClass = assets.filter(asset => asset.asset_class === id).sort((a, b) => b.score - a.score);
      return {
        id,
        label: classLabels[id],
        top_assets: inClass.slice(0, 3).map(asset => asset.ticker),
        ...scoreClass(inClass.map(asset => asset.score), id, macro, profile),
      };
    }),
  ].sort((a, b) => b.score - a.score);

  const ranking = [...assets].sort((a, b) => b.score - a.score);
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
}

export function startMarketRefresh(intervalMs = 60 * 60 * 1000) {
  const run = () => refreshMarketData().catch(error => console.error('Falha ao atualizar dados de mercado:', error));
  void run();
  setInterval(run, intervalMs).unref();
}
