export type MonthlyReturns = Map<string, number>;

type BcbPoint = { data: string; valor: string };

type YahooMonthlyResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }> | null;
  };
};

const cacheDurationMs = 12 * 60 * 60 * 1000;
const historyStart = Date.UTC(2003, 0, 1) / 1000;
const bcbCache = new Map<number, { value: MonthlyReturns; fetchedAt: number }>();
const yahooCache = new Map<string, { value: Map<string, number>; fetchedAt: number }>();

export const monthKey = (date: Date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

export function shiftMonth(key: string, delta: number): string {
  const [year, month] = key.split('-').map(Number);
  return monthKey(new Date(Date.UTC(year, month - 1 + delta, 1)));
}

async function fetchBcbPoints(code: number, attempt = 1): Promise<Array<{ key: string; value: number }>> {
  const end = new Date();
  let response: Response;
  try {
    response = await fetch(
      `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json&dataInicial=01/01/2003&dataFinal=${String(end.getUTCDate()).padStart(2, '0')}/${String(end.getUTCMonth() + 1).padStart(2, '0')}/${end.getUTCFullYear()}`,
      { signal: AbortSignal.timeout(20000) }
    );
  } catch (error) {
    // A API do Banco Central oscila; uma nova tentativa resolve a maioria das falhas.
    if (attempt < 3) return fetchBcbPoints(code, attempt + 1);
    throw error;
  }
  if (!response.ok) {
    if (attempt < 3 && response.status >= 500) return fetchBcbPoints(code, attempt + 1);
    throw new Error(`Banco Central indisponível (HTTP ${response.status}).`);
  }

  const points = ((await response.json()) as BcbPoint[]).flatMap(point => {
    const [, month, year] = point.data.split('/');
    const value = Number(point.valor);
    return year && month && Number.isFinite(value) ? [{ key: `${year}-${month}`, value }] : [];
  });
  if (points.length < 12) throw new Error('O Banco Central retornou uma série inválida.');
  return points;
}

// Séries mensais do SGS (CDI, Selic, IPCA, TR) vêm em % no mês.
export async function getBcbMonthlyReturns(code: number): Promise<MonthlyReturns> {
  const cached = bcbCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < cacheDurationMs) return cached.value;

  try {
    const result: MonthlyReturns = new Map(
      (await fetchBcbPoints(code)).map(point => [point.key, point.value / 100])
    );
    bcbCache.set(code, { value: result, fetchedAt: Date.now() });
    return result;
  } catch (error) {
    if (cached) return cached.value;
    throw error;
  }
}

const bcbLevelCache = new Map<number, { value: Map<string, number>; fetchedAt: number }>();

// Séries de nível mensal (ex.: 3696 = dólar PTAX de fim de mês).
export async function getBcbMonthlyLevels(code: number): Promise<Map<string, number>> {
  const cached = bcbLevelCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < cacheDurationMs) return cached.value;

  try {
    const currentKey = monthKey(new Date());
    const levels = new Map(
      (await fetchBcbPoints(code)).filter(point => point.key !== currentKey && point.value > 0).map(point => [point.key, point.value] as [string, number])
    );
    bcbLevelCache.set(code, { value: levels, fetchedAt: Date.now() });
    return levels;
  } catch (error) {
    if (cached) return cached.value;
    throw error;
  }
}

// Níveis de fechamento no fim de cada mês, descartando o mês corrente (incompleto).
// Usa dados diários porque as barras mensais do Yahoo têm meses faltando em períodos antigos.
export async function getYahooMonthlyLevels(symbol: string): Promise<Map<string, number>> {
  const cached = yahooCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < cacheDurationMs) return cached.value;

  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${historyStart}&period2=${Math.floor(Date.now() / 1000) + 86400}&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) }
    );
    if (!response.ok) throw new Error(`Serviço de cotação indisponível (HTTP ${response.status}).`);

    const result = ((await response.json()) as YahooMonthlyResponse).chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.adjclose?.[0]?.adjclose ?? result?.indicators?.quote?.[0]?.close ?? [];
    const currentKey = monthKey(new Date());

    const levels = new Map<string, number>();
    timestamps.forEach((timestamp, index) => {
      const close = closes[index];
      // +12h evita que fusos à frente do UTC joguem a barra para o mês anterior.
      const key = monthKey(new Date((timestamp + 12 * 3600) * 1000));
      if (typeof close === 'number' && Number.isFinite(close) && close > 0 && key !== currentKey) {
        levels.set(key, close);
      }
    });
    if (levels.size < 12) throw new Error('Histórico mensal insuficiente.');
    yahooCache.set(symbol, { value: levels, fetchedAt: Date.now() });
    return levels;
  } catch (error) {
    if (cached) return cached.value;
    throw error;
  }
}

export function levelsToReturns(levels: Map<string, number>): MonthlyReturns {
  const returns: MonthlyReturns = new Map();
  for (const [key, level] of levels) {
    const previous = levels.get(shiftMonth(key, -1));
    if (previous) returns.set(key, level / previous - 1);
  }
  return returns;
}

export function combineReturns(a: MonthlyReturns, b: MonthlyReturns): MonthlyReturns {
  const combined: MonthlyReturns = new Map();
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other !== undefined) combined.set(key, (1 + value) * (1 + other) - 1);
  }
  return combined;
}
