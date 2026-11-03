type BcbPoint = { data: string; valor: string };

export type BcbMacro = {
  selic: number;
  cdi: number;
  ipca12m: number;
  realRate: number;
  referenceDate: string;
};

// Séries do SGS/Banco Central: 432 Selic meta, 4389 CDI anualizado, 13522 IPCA acumulado em 12 meses.
const series = { selic: 432, cdi: 4389, ipca12m: 13522 } as const;
const cacheDurationMs = 6 * 60 * 60 * 1000;
let cached: { value: BcbMacro; expiresAt: number } | undefined;

async function lastValue(code: number): Promise<{ value: number; date: string }> {
  const response = await fetch(
    `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados/ultimos/1?formato=json`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!response.ok) {
    throw new Error(`Banco Central indisponível (HTTP ${response.status}).`);
  }
  const point = ((await response.json()) as BcbPoint[])[0];
  const value = Number(point?.valor);
  if (!point || !Number.isFinite(value)) {
    throw new Error('O Banco Central retornou uma resposta inválida.');
  }
  return { value, date: point.data };
}

export async function getBcbMacro(): Promise<BcbMacro> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const [selic, cdi, ipca] = await Promise.all([
      lastValue(series.selic),
      lastValue(series.cdi),
      lastValue(series.ipca12m),
    ]);
    const value: BcbMacro = {
      selic: selic.value,
      cdi: cdi.value,
      ipca12m: ipca.value,
      realRate: ((1 + cdi.value / 100) / (1 + ipca.value / 100) - 1) * 100,
      referenceDate: cdi.date,
    };
    cached = { value, expiresAt: Date.now() + cacheDurationMs };
    return value;
  } catch (error) {
    if (cached) return cached.value;
    throw error;
  }
}
