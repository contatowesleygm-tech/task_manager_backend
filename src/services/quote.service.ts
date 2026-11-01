import { AUTO_QUOTE_TYPES, B3_ASSET_TYPES, type AssetType } from './investment-types';

type CachedQuote = {
  price: number;
  date: string;
  expiresAt: number;
};

type YahooChartResponse = {
  chart?: {
    result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number } }> | null;
  };
};

export { AUTO_QUOTE_TYPES, B3_ASSET_TYPES };

const cache = new Map<string, CachedQuote>();
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
