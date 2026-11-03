import { monthKey } from './historical-data.service';

export type DailyPrices = {
  symbol: string;
  latestPrice: number;
  latestDate: string;
  firstDate: string;
  // Fechamento (sem ajuste por proventos) do último pregão de cada mês completo.
  monthEnd: Map<string, number>;
  // Proventos reais por mês (data ex). Completos só nos últimos anos; antes há apenas eventos isolados.
  dividends: Map<string, number>;
  fetchedAt: number;
};

type YahooDailyResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      events?: { dividends?: Record<string, { amount?: number; date?: number }> };
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }> | null;
  };
};

const cache = new Map<string, DailyPrices>();
const cacheDurationMs = 12 * 60 * 60 * 1000;
const start = Date.UTC(2003, 0, 1) / 1000;

export async function getDailyPrices(symbol: string): Promise<DailyPrices> {
  if (!/^[A-Z0-9.=^-]{1,20}$/.test(symbol)) throw new Error('Ticker inválido.');
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < cacheDurationMs) return cached;

  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${Math.floor(Date.now() / 1000) + 86400}&interval=1d&events=div`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) }
    );
    if (!response.ok) throw new Error(`Serviço de cotação indisponível (HTTP ${response.status}).`);

    const result = ((await response.json()) as YahooDailyResponse).chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const currentKey = monthKey(new Date());

    const monthEnd = new Map<string, number>();
    let latest: { price: number; time: number } | undefined;
    let first: number | undefined;
    timestamps.forEach((timestamp, index) => {
      const close = closes[index];
      if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) return;
      first ??= timestamp;
      latest = { price: close, time: timestamp };
      const key = monthKey(new Date((timestamp + 12 * 3600) * 1000));
      if (key !== currentKey) monthEnd.set(key, close);
    });
    if (!latest || first === undefined || monthEnd.size < 6) throw new Error('Histórico de preços insuficiente.');

    const dividends = new Map<string, number>();
    for (const item of Object.values(result?.events?.dividends ?? {})) {
      if (typeof item.amount !== 'number' || typeof item.date !== 'number' || item.amount <= 0) continue;
      const key = monthKey(new Date((item.date + 12 * 3600) * 1000));
      dividends.set(key, (dividends.get(key) ?? 0) + item.amount);
    }

    const value: DailyPrices = {
      symbol,
      latestPrice: latest.price,
      latestDate: new Date(latest.time * 1000).toISOString().slice(0, 10),
      firstDate: new Date(first * 1000).toISOString().slice(0, 10),
      monthEnd,
      dividends,
      fetchedAt: Date.now(),
    };
    cache.set(symbol, value);
    return value;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}
