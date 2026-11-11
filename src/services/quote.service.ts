import { AUTO_QUOTE_TYPES, B3_ASSET_TYPES, type AssetType } from './investment-types';

type CachedQuote = {
  price: number;
  date: string;
  expiresAt: number;
};

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number; regularMarketTime?: number };
      timestamp?: number[];
      events?: { dividends?: Record<string, { amount?: number; date?: number }> };
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }> | null;
  };
};

export { AUTO_QUOTE_TYPES, B3_ASSET_TYPES };

const cache = new Map<string, CachedQuote>();
const basicsCache = new Map<string, { price: number; date: string; dividendPerShare: number; dividendDate: string | null; expiresAt: number }>();
const cacheDurationMs = 5 * 60 * 1000;
const b3TickerPattern = /^[A-Z0-9]{4,7}$/;
const yahooTickerPattern = /^[A-Z0-9.=^-]{1,20}$/;

function yahooSymbol(ticker: string, assetType: string): string {
  const symbol = ticker.trim().toUpperCase();
  if (B3_ASSET_TYPES.includes(assetType as AssetType)) {
    if (!b3TickerPattern.test(symbol)) {
      throw new Error('Ticker inválido para cotação automática.');
    }
    return `${symbol}.SA`;
  }
  if (!yahooTickerPattern.test(symbol)) {
    throw new Error('Ticker inválido para cotação automática.');
  }
  if (assetType === 'cripto' && !symbol.includes('-') && !symbol.includes('=')) {
    return `${symbol}-USD`;
  }
  return symbol;
}

export async function getMarketQuote(ticker: string, assetType: string): Promise<{ price: number; date: string }> {
  if (!AUTO_QUOTE_TYPES.includes(assetType as AssetType)) {
    throw new Error('Este tipo de ativo não tem cotação automática.');
  }

  const symbol = yahooSymbol(ticker, assetType);
  const cached = cache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return { price: cached.price, date: cached.date };
  }

  const response = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
  );
  if (!response.ok) {
    throw new Error(`Serviço de cotação indisponível (HTTP ${response.status}).`);
  }

  const meta = ((await response.json()) as YahooChartResponse).chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new Error('O serviço de cotação retornou uma resposta inválida.');
  }

  const date = meta?.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();
  cache.set(symbol, { price, date, expiresAt: Date.now() + cacheDurationMs });
  return { price, date };
}

export async function getB3Quote(ticker: string): Promise<{ price: number; date: string }> {
  return getMarketQuote(ticker, 'acao');
}

export async function getMarketAssetBasics(
  ticker: string,
  assetType: string
): Promise<{ price: number; date: string; dividendPerShare: number; dividendDate: string | null }> {
  if (!AUTO_QUOTE_TYPES.includes(assetType as AssetType)) {
    throw new Error('Este tipo de ativo não tem cotação automática.');
  }

  const symbol = yahooSymbol(ticker, assetType);
  const cached = basicsCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      price: cached.price,
      date: cached.date,
      dividendPerShare: cached.dividendPerShare,
      dividendDate: cached.dividendDate,
    };
  }

  const response = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=div`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
  );
  if (!response.ok) {
    throw new Error(`Serviço de cotação indisponível (HTTP ${response.status}).`);
  }

  const result = ((await response.json()) as YahooChartResponse).chart?.result?.[0];
  const meta = result?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new Error('O serviço de cotação retornou uma resposta inválida.');
  }

  const now = Math.floor(Date.now() / 1000);
  const latestDividend = Object.values(result?.events?.dividends ?? {})
    .filter((item): item is { amount: number; date: number } =>
      typeof item.amount === 'number' && Number.isFinite(item.amount) && item.amount > 0
      && typeof item.date === 'number' && item.date <= now)
    .sort((a, b) => b.date - a.date)[0];
  const date = meta?.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();
  const value = {
    price,
    date,
    dividendPerShare: latestDividend?.amount ?? 0,
    dividendDate: latestDividend ? new Date(latestDividend.date * 1000).toISOString().slice(0, 10) : null,
    expiresAt: Date.now() + cacheDurationMs,
  };
  basicsCache.set(symbol, value);
  return {
    price: value.price,
    date: value.date,
    dividendPerShare: value.dividendPerShare,
    dividendDate: value.dividendDate,
  };
}
