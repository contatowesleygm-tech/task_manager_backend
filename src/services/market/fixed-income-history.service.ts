type BcbDailyRate = { data: string; valor: string };

export class FixedIncomeHistoryError extends Error {
  constructor(message: string, readonly statusCode: 400 | 502) {
    super(message);
    this.name = 'FixedIncomeHistoryError';
  }
}

export interface FixedIncomeHistoryMonth {
  month: string;
  as_of_date: string;
  days_held: number;
  gross_balance: number;
  accumulated_gain: number;
  income_tax_rate: number;
  estimated_tax: number;
  net_balance: number;
}

export interface FixedIncomeHistoryYear {
  year: number;
  start_balance: number;
  end_balance: number;
  gain_in_year: number;
  accumulated_gain: number;
  income_tax_rate: number;
  estimated_tax: number;
  net_balance: number;
}

const cacheDurationMs = 6 * 60 * 60 * 1000;
const dailyRatesCache = new Map<string, { rates: Array<{ date: string; annualRate: number }>; expiresAt: number }>();

function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new FixedIncomeHistoryError('Data do investimento inválida.', 400);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new FixedIncomeHistoryError('Data do investimento inválida.', 400);
  }
  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function bcbDate(date: Date): string {
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function incomeTaxRate(daysHeld: number, exempt: boolean): number {
  if (exempt) return 0;
  if (daysHeld <= 180) return 0.225;
  if (daysHeld <= 360) return 0.2;
  if (daysHeld <= 720) return 0.175;
  return 0.15;
}

async function getDailyCdiRates(from: Date, to: Date) {
  const key = `${isoDate(from)}:${isoDate(to)}`;
  const cached = dailyRatesCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rates;

  const url = new URL('https://api.bcb.gov.br/dados/serie/bcdata.sgs.4389/dados');
  url.searchParams.set('formato', 'json');
  url.searchParams.set('dataInicial', bcbDate(from));
  url.searchParams.set('dataFinal', bcbDate(to));

  let response: Response;
  let body: unknown;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new FixedIncomeHistoryError(`Banco Central indisponível ao consultar o histórico do CDI (HTTP ${response.status}).`, 502);
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof FixedIncomeHistoryError) throw error;
    throw new FixedIncomeHistoryError('Não foi possível consultar o histórico do CDI no Banco Central. Tente novamente mais tarde.', 502);
  }
  if (!Array.isArray(body)) {
    throw new FixedIncomeHistoryError('O Banco Central retornou um histórico de CDI inválido.', 502);
  }
  const rates = body.flatMap((point: BcbDailyRate) => {
    if (!point || typeof point.data !== 'string' || typeof point.valor !== 'string') return [];
    const [day, month, year] = point.data.split('/').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    const annualRate = Number(point.valor);
    if (
      date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
      || !Number.isFinite(annualRate) || annualRate < 0
    ) return [];
    return [{ date: isoDate(date), annualRate }];
  }).sort((a, b) => a.date.localeCompare(b.date));

  if (rates.length === 0 && isoDate(from) !== isoDate(to)) {
    throw new FixedIncomeHistoryError('O Banco Central não retornou CDI para o período do investimento.', 502);
  }
  dailyRatesCache.set(key, { rates, expiresAt: Date.now() + cacheDurationMs });
  return rates;
}

export async function buildFixedIncomeHistory(input: {
  principal: number;
  cdiPercent: number;
  investmentDate: string;
  incomeTaxExempt: boolean;
}) {
  const investmentDate = parseIsoDate(input.investmentDate);
  const today = new Date();
  const todayParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  const todayValue = (type: string) => Number(todayParts.find(part => part.type === type)?.value);
  const todayDate = new Date(Date.UTC(todayValue('year'), todayValue('month') - 1, todayValue('day')));
  if (investmentDate > todayDate) {
    throw new FixedIncomeHistoryError('A data do investimento não pode estar no futuro. Corrija a data no cadastro para consultar o histórico.', 400);
  }

  const dailyRates = await getDailyCdiRates(investmentDate, todayDate);
  const months: FixedIncomeHistoryMonth[] = [];
  let balance = input.principal;
  let rateIndex = 0;
  while (rateIndex < dailyRates.length && dailyRates[rateIndex].date <= isoDate(investmentDate)) {
    rateIndex += 1;
  }
  let year = investmentDate.getUTCFullYear();
  let month = investmentDate.getUTCMonth();

  while (year < todayDate.getUTCFullYear() || (year === todayDate.getUTCFullYear() && month <= todayDate.getUTCMonth())) {
    const calendarMonthEnd = new Date(Date.UTC(year, month + 1, 0));
    const asOfDate = calendarMonthEnd < todayDate ? calendarMonthEnd : todayDate;
    const asOfDateText = isoDate(asOfDate);

    while (rateIndex < dailyRates.length && dailyRates[rateIndex].date <= asOfDateText) {
      const dailyRate = Math.pow(1 + dailyRates[rateIndex].annualRate / 100, 1 / 252) - 1;
      balance *= 1 + dailyRate * input.cdiPercent / 100;
      rateIndex += 1;
    }

    const daysHeld = Math.max(0, Math.floor((asOfDate.getTime() - investmentDate.getTime()) / 86_400_000));
    const gain = Math.max(0, balance - input.principal);
    const taxRate = incomeTaxRate(daysHeld, input.incomeTaxExempt);
    const estimatedTax = round2(gain * taxRate);
    months.push({
      month: `${year}-${String(month + 1).padStart(2, '0')}`,
      as_of_date: asOfDateText,
      days_held: daysHeld,
      gross_balance: round2(balance),
      accumulated_gain: round2(gain),
      income_tax_rate: taxRate,
      estimated_tax: estimatedTax,
      net_balance: round2(balance - estimatedTax),
    });

    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }

  const years: FixedIncomeHistoryYear[] = [];
  for (const point of months) {
    const yearNumber = Number(point.month.slice(0, 4));
    const previous = years[years.length - 1];
    const startBalance = previous?.year === yearNumber
      ? previous.start_balance
      : previous?.end_balance ?? input.principal;
    const current: FixedIncomeHistoryYear = {
      year: yearNumber,
      start_balance: round2(startBalance),
      end_balance: point.gross_balance,
      gain_in_year: round2(point.gross_balance - startBalance),
      accumulated_gain: point.accumulated_gain,
      income_tax_rate: point.income_tax_rate,
      estimated_tax: point.estimated_tax,
      net_balance: point.net_balance,
    };
    if (previous?.year === yearNumber) years[years.length - 1] = current;
    else years.push(current);
  }

  const current = months[months.length - 1];
  return {
    investment_date: input.investmentDate,
    as_of_date: isoDate(todayDate),
    cdi_reference_date: dailyRates[dailyRates.length - 1]?.date ?? input.investmentDate,
    applied_amount: round2(input.principal),
    cdi_percent: input.cdiPercent,
    income_tax_exempt: input.incomeTaxExempt,
    cdi_source: 'Banco Central do Brasil (SGS 4389), CDI diário anualizado',
    current: current ? {
      gross_balance: current.gross_balance,
      accumulated_gain: current.accumulated_gain,
      income_tax_rate: current.income_tax_rate,
      estimated_tax: current.estimated_tax,
      net_balance: current.net_balance,
    } : {
      gross_balance: round2(input.principal),
      accumulated_gain: 0,
      income_tax_rate: incomeTaxRate(0, input.incomeTaxExempt),
      estimated_tax: 0,
      net_balance: round2(input.principal),
    },
    months,
    years,
  };
}
