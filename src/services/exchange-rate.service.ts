type FrankfurterRate = {
  date?: string;
  rate?: number;
};

type CachedRate = {
  rate: number;
  date: string;
  expiresAt: number;
};

let cachedUsdBrlRate: CachedRate | undefined;
const cacheDurationMs = 60 * 60 * 1000;

export async function getUsdToBrlRate(): Promise<{ rate: number; date: string }> {
  if (cachedUsdBrlRate && cachedUsdBrlRate.expiresAt > Date.now()) {
    return { rate: cachedUsdBrlRate.rate, date: cachedUsdBrlRate.date };
  }

  const response = await fetch('https://api.frankfurter.dev/v2/rate/usd/brl', {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Serviço de cotação indisponível (HTTP ${response.status}).`);
  }

  const result = await response.json() as FrankfurterRate;
  if (!result.date || typeof result.rate !== 'number' || !Number.isFinite(result.rate) || result.rate <= 0) {
    throw new Error('O serviço de cotação retornou uma resposta inválida.');
  }

  cachedUsdBrlRate = {
    rate: result.rate,
    date: result.date,
    expiresAt: Date.now() + cacheDurationMs,
  };
  return { rate: result.rate, date: result.date };
}
