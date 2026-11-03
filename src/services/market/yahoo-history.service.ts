export type PriceHistory = {
  symbol: string;
  closes: number[];
  dividends: Array<{ date: number; amount: number }>;
  fetchedAt: number;
};

type YahooHistoryResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      events?: { dividends?: Record<string, { amount?: number; date?: number }> };
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }> | null;
  };
};

const cache = new Map<string, PriceHistory>();
const cacheDurationMs = 60 * 60 * 1000;
const symbolPattern = /^[A-Z0-9.=^-]{1,20}$/;

export function isValidSymbol(symbol: string): boolean {
  return symbolPattern.test(symbol);
}

export async function getPriceHistory(symbol: string): Promise<PriceHistory> {
  if (!isValidSymbol(symbol)) {
    throw new Error('Ticker inválido.');
  }

  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < cacheDurationMs) return cached;

  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=div`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) {
      throw new Error(`Serviço de cotação indisponível (HTTP ${response.status}).`);
    }

    const result = ((await response.json()) as YahooHistoryResponse).chart?.result?.[0];
    const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
    );
    if (closes.length < 60) {
      throw new Error('Histórico insuficiente para análise.');
    }

    const dividends = Object.values(result?.events?.dividends ?? {})
      .filter((item): item is { amount: number; date: number } =>
        typeof item.amount === 'number' && typeof item.date === 'number')
      .map(item => ({ date: item.date, amount: item.amount }));

    const history = { symbol, closes, dividends, fetchedAt: Date.now() };
    cache.set(symbol, history);
    return history;
  } catch (error) {
    // Em falha do Yahoo, um histórico antigo ainda é melhor que nenhuma análise.
    if (cached) return cached;
    throw error;
  }
}
