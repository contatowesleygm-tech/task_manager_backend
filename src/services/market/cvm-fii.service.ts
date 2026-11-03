import { unzipSync } from 'fflate';

export type CvmFund = {
  cnpj: string;
  name: string;
  isin: string;
  inceptionDate: string | null;
  segment: string | null;
  mandate: string | null;
  management: string | null;
};

export type CvmMonth = {
  key: string;
  vp: number;
  // Rendimento e amortização do mês, como fração do valor patrimonial por cota do mês anterior.
  dy: number;
  amortization: number;
  equity: number | null;
  holders: number | null;
  shares: number | null;
};

type CvmData = {
  fundsByCode: Map<string, CvmFund>;
  months: Map<string, CvmMonth[]>;
  latestKey: string;
  fetchedAt: number;
};

const baseUrl = 'https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS';
const firstYear = 2016;
const cacheDurationMs = 24 * 60 * 60 * 1000;
let cached: CvmData | undefined;
let inFlight: Promise<CvmData> | undefined;

function parseCsv(bytes: Uint8Array): Array<Record<string, string>> {
  const lines = new TextDecoder('windows-1252').decode(bytes).split('\n');
  const header = lines[0].replace('\r', '').split(';');
  const rows: Array<Record<string, string>> = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].replace('\r', '');
    if (!line) continue;
    const cells = line.split(';');
    const row: Record<string, string> = {};
    header.forEach((name, column) => { row[name] = cells[column] ?? ''; });
    rows.push(row);
  }
  return rows;
}

const number = (value: string | undefined) => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : null;
};

async function downloadYear(year: number): Promise<Record<string, Uint8Array> | undefined> {
  const response = await fetch(`${baseUrl}/inf_mensal_fii_${year}.zip`, { signal: AbortSignal.timeout(60000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`CVM indisponível (HTTP ${response.status}).`);
  const wantsGeneral = year >= new Date().getFullYear() - 1;
  return unzipSync(new Uint8Array(await response.arrayBuffer()), {
    filter: file => file.name.includes('_complemento_') || (wantsGeneral && file.name.includes('_geral_')),
  });
}

async function loadFromCvm(): Promise<CvmData> {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - firstYear + 1 }, (_, index) => firstYear + index);

  const files = new Map<number, Record<string, Uint8Array>>();
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < years.length) {
      const year = years[next++];
      const result = await downloadYear(year);
      if (result) files.set(year, result);
    }
  }));
  if (!files.size) throw new Error('Não foi possível obter os dados da CVM.');

  const fundsByCode = new Map<string, CvmFund & { reference: string }>();
  const best = new Map<string, { version: number; month: CvmMonth; cnpj: string }>();

  for (const year of [...files.keys()].sort()) {
    for (const [name, bytes] of Object.entries(files.get(year)!)) {
      const rows = parseCsv(bytes);
      if (name.includes('_geral_')) {
        for (const row of rows) {
          const code = /^BR([A-Z0-9]{4})CTF\d{3}$/.exec(row.Codigo_ISIN ?? '')?.[1];
          if (!code) continue;
          const reference = row.Data_Referencia ?? '';
          const existing = fundsByCode.get(code);
          if (existing && existing.reference > reference) continue;
          const cnpj = row.CNPJ_Fundo_Classe || row.CNPJ_Fundo;
          fundsByCode.set(code, {
            cnpj,
            name: row.Nome_Fundo_Classe,
            isin: row.Codigo_ISIN,
            inceptionDate: row.Data_Funcionamento || null,
            segment: row.Segmento_Atuacao || null,
            mandate: row.Mandato || null,
            management: row.Tipo_Gestao || null,
            reference,
          });
        }
      } else {
        for (const row of rows) {
          const vp = number(row.Valor_Patrimonial_Cotas);
          const dy = number(row.Percentual_Dividend_Yield_Mes);
          const cnpj = row.CNPJ_Fundo_Classe || row.CNPJ_Fundo;
          if (!cnpj || !row.Data_Referencia || vp === null || vp <= 0 || dy === null) continue;
          const key = row.Data_Referencia.slice(0, 7);
          const version = Number(row.Versao) || 1;
          const id = `${cnpj}|${key}`;
          if ((best.get(id)?.version ?? 0) > version) continue;
          best.set(id, {
            version,
            cnpj,
            month: {
              key, vp, dy,
              amortization: number(row.Percentual_Amortizacao_Cotas_Mes) ?? 0,
              equity: number(row.Patrimonio_Liquido),
              holders: number(row.Total_Numero_Cotistas),
              shares: number(row.Cotas_Emitidas),
            },
          });
        }
      }
    }
  }

  const months = new Map<string, CvmMonth[]>();
  for (const { cnpj, month } of best.values()) {
    const list = months.get(cnpj) ?? [];
    list.push(month);
    months.set(cnpj, list);
  }
  let latestKey = '';
  for (const list of months.values()) {
    list.sort((a, b) => a.key.localeCompare(b.key));
    normalizeSplits(list);
    if (list[list.length - 1].key > latestKey) latestKey = list[list.length - 1].key;
  }
  return { fundsByCode, months, latestKey, fetchedAt: Date.now() };
}

// O Yahoo ajusta os preços por desdobramentos/grupamentos, mas o valor patrimonial da CVM não.
// Um evento é detectado quando as cotas mudam e o VP muda na proporção inversa.
function normalizeSplits(list: CvmMonth[]) {
  let cumulative = 1;
  for (let index = list.length - 1; index > 0; index--) {
    const current = list[index];
    const previous = list[index - 1];
    if (current.shares && previous.shares) {
      const factor = current.shares / previous.shares;
      const isSplit = (factor >= 1.8 || factor <= 0.56) && Math.abs((current.vp / previous.vp) * factor - 1) < 0.25;
      if (isSplit) cumulative *= factor;
    }
    previous.vp /= cumulative;
  }
}

export async function getCvmFiiData(): Promise<CvmData> {
  if (cached && Date.now() - cached.fetchedAt < cacheDurationMs) return cached;
  inFlight ??= loadFromCvm()
    .then(data => { cached = data; return data; })
    .catch(error => {
      // Dados antigos ainda servem melhor que nenhuma análise.
      if (cached) return cached;
      throw error;
    })
    .finally(() => { inFlight = undefined; });
  return inFlight;
}

type B3Listing = { listedAt: string | null; fetchedAt: number };
const listingCache = new Map<string, B3Listing>();

// Data de início da negociação na B3 (idade em bolsa). Falhas aqui não impedem a análise.
export async function getB3ListingDate(code: string): Promise<string | null> {
  const hit = listingCache.get(code);
  if (hit && Date.now() - hit.fetchedAt < cacheDurationMs) return hit.listedAt;

  try {
    const payload = Buffer.from(JSON.stringify({ identifierFund: code, typeFund: 7 })).toString('base64');
    const response = await fetch(
      `https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/${payload}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    if (!response.ok) throw new Error(`B3 indisponível (HTTP ${response.status}).`);
    const [day, month, year] = (((await response.json()) as { quotedPer?: string }).quotedPer ?? '').split('/');
    const listedAt = year && month && day ? `${year}-${month}-${day}` : null;
    listingCache.set(code, { listedAt, fetchedAt: Date.now() });
    return listedAt;
  } catch {
    return hit?.listedAt ?? null;
  }
}
