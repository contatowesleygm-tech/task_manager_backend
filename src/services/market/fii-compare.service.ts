import { getBcbMonthlyReturns, shiftMonth, type MonthlyReturns } from './historical-data.service';
import { getB3ListingDate, getCvmFiiData, type CvmMonth } from './cvm-fii.service';
import { clamp } from './indicators';
import { buildScored } from './scoring';
import { getDailyPrices, type DailyPrices } from './yahoo-daily.service';

export class FiiInputError extends Error {}

export const defaultFiiTickers = ['HGLG11', 'XPLG11', 'KNRI11', 'MXRF11', 'XPML11', 'VISC11', 'BTLG11', 'KNCR11'];

type Point = { key: string; price: number; vp: number; dist: number; equity: number | null; holders: number | null };

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const pct = (value: number | null) => (value === null ? null : round(value * 100));
const yearsBetween = (from: string, to: Date) => (to.getTime() - new Date(from).getTime()) / (365.25 * 24 * 3600 * 1000);

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Monta a série mensal contígua mais recente em que há preço (Yahoo) e dados da CVM.
// Proventos: maior valor entre o Yahoo (completo só nos últimos anos) e a estimativa da CVM
// (cobre 2017 em diante, mas alguns fundos reportam zero); cada fonte tem lacunas em períodos diferentes.
function buildPoints(cvm: CvmMonth[], prices: DailyPrices): Point[] {
  const byKey = new Map(cvm.map(month => [month.key, month]));
  let lastKey = [...byKey.keys()].filter(key => prices.monthEnd.has(key)).sort().pop();
  const points: Point[] = [];
  while (lastKey && byKey.has(lastKey) && prices.monthEnd.has(lastKey)) {
    const month = byKey.get(lastKey)!;
    const previous = byKey.get(shiftMonth(lastKey, -1));
    // Estimativa CVM: rendimento % × VP do mês anterior (confere com os pagamentos reais dos fundos).
    const cvmDist = previous ? (month.dy + month.amortization) * previous.vp : 0;
    points.push({
      key: lastKey,
      price: prices.monthEnd.get(lastKey)!,
      vp: month.vp,
      dist: Math.max(prices.dividends.get(lastKey) ?? 0, cvmDist),
      equity: month.equity,
      holders: month.holders,
    });
    lastKey = shiftMonth(lastKey, -1);
  }
  return points.reverse();
}

function accumulate(returns: MonthlyReturns, keys: string[]): number | null {
  let total = 1;
  for (const key of keys) {
    const value = returns.get(key);
    if (value === undefined) return null;
    total *= 1 + value;
  }
  return total - 1;
}

function monthlyTotalReturns(points: Point[]) {
  return points.slice(1).map((point, index) => (point.price + point.dist) / points[index].price - 1);
}

function windowStats(points: Point[], months: number, cdi: MonthlyReturns, ipca: MonthlyReturns) {
  if (points.length < months + 1) return null;
  const slice = points.slice(-(months + 1));
  const keys = slice.slice(1).map(point => point.key);
  const returns = monthlyTotalReturns(slice);
  const total = returns.reduce((acc, value) => acc * (1 + value), 1) - 1;
  const years = months / 12;
  const cagr = (1 + total) ** (1 / years) - 1;

  const cdiTotal = accumulate(cdi, keys);
  const ipcaTotal = accumulate(ipca, keys);
  const cdiCagr = cdiTotal === null ? null : (1 + cdiTotal) ** (1 / years) - 1;
  const ipcaCagr = ipcaTotal === null ? null : (1 + ipcaTotal) ** (1 / years) - 1;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const volatility = returns.length > 1
    ? Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)) * Math.sqrt(12)
    : null;

  let level = 1;
  let peak = 1;
  let peakKey = slice[0].key;
  let worst = { depth: 0, peak: peakKey, trough: peakKey };
  returns.forEach((value, index) => {
    level *= 1 + value;
    if (level > peak) { peak = level; peakKey = keys[index]; }
    if (level / peak - 1 < worst.depth) worst = { depth: level / peak - 1, peak: peakKey, trough: keys[index] };
  });

  return {
    months,
    from: keys[0],
    to: keys[keys.length - 1],
    price_return_pct: pct(slice[slice.length - 1].price / slice[0].price - 1),
    distributions_per_share: round(slice.slice(1).reduce((sum, point) => sum + point.dist, 0)),
    total_return_pct: pct(total),
    total_cagr_pct: pct(cagr),
    cdi_cagr_pct: pct(cdiCagr),
    ipca_cagr_pct: pct(ipcaCagr),
    excess_over_cdi_pp: cdiCagr === null ? null : pct(cagr - cdiCagr),
    real_cagr_pct: ipcaCagr === null ? null : pct((1 + cagr) / (1 + ipcaCagr) - 1),
    annual_volatility_pct: pct(volatility),
    max_drawdown_pct: pct(worst.depth),
    drawdown_peak: worst.depth < 0 ? worst.peak : null,
    drawdown_trough: worst.depth < 0 ? worst.trough : null,
    _raw: { cagr, cdiCagr, volatility, drawdown: worst.depth, total, cdiTotal, ipcaTotal },
  };
}

type WindowStats = NonNullable<ReturnType<typeof windowStats>>;
const publicStats = (stats: WindowStats | null) => {
  if (!stats) return null;
  const { _raw, ...rest } = stats;
  void _raw;
  return rest;
};

function yearlyHistory(points: Point[]) {
  const years = [...new Set(points.slice(1).map(point => point.key.slice(0, 4)))];
  return years.map(year => {
    const indexes = points.map((point, index) => ({ point, index })).filter(item => item.index > 0 && item.point.key.startsWith(year));
    const startPrice = points[indexes[0].index - 1].price;
    const endPrice = indexes[indexes.length - 1].point.price;
    const dist = indexes.reduce((sum, item) => sum + item.point.dist, 0);
    const total = indexes.reduce((acc, item) => acc * ((item.point.price + item.point.dist) / points[item.index - 1].price), 1) - 1;
    return {
      year: Number(year),
      months: indexes.length,
      partial: indexes.length < 12,
      price_return_pct: pct(endPrice / startPrice - 1),
      distributions_per_share: round(dist),
      dividend_yield_on_start_price_pct: pct(dist / startPrice),
      total_return_pct: pct(total),
    };
  });
}

type Analysis = Awaited<ReturnType<typeof analyzeFund>>;

async function analyzeFund(ticker: string, cdi: MonthlyReturns, ipca: MonthlyReturns, now: Date) {
  const code = ticker.slice(0, 4);
  const cvm = await getCvmFiiData();
  const fund = cvm.fundsByCode.get(code);
  const cvmMonths = fund ? cvm.months.get(fund.cnpj) : undefined;
  if (!fund || !cvmMonths?.length) throw new FiiInputError('Fundo não encontrado na base da CVM.');

  const [prices, listedAt] = await Promise.all([getDailyPrices(`${ticker}.SA`), getB3ListingDate(code)]);
  const points = buildPoints(cvmMonths, prices);
  if (points.length < 13) throw new FiiInputError('Histórico insuficiente para análise (menos de 12 meses).');

  const last = points[points.length - 1];
  const dist12 = points.slice(-12).reduce((sum, point) => sum + point.dist, 0);
  const recent = points.slice(-Math.min(60, points.length - 1));
  const paidMonths = recent.filter(point => point.dist > 0).length / recent.length;
  const last24 = points.slice(-24).map(point => point.dist);
  const mean24 = last24.reduce((sum, value) => sum + value, 0) / last24.length;
  const cv24 = mean24 > 0 && last24.length >= 12
    ? Math.sqrt(last24.reduce((sum, value) => sum + (value - mean24) ** 2, 0) / last24.length) / mean24
    : null;

  const dist12Before = points.length >= 48 ? points.slice(-48, -36).reduce((sum, point) => sum + point.dist, 0) : 0;
  const distGrowth = dist12Before > 0 ? (dist12 / dist12Before) ** (1 / 3) - 1 : null;

  const averageYield = recent.length >= 12
    ? recent.reduce((sum, point, index) => sum + point.dist / (index ? recent[index - 1].price : points[points.length - recent.length - 1].price), 0) / recent.length * 12
    : null;

  const pvp = prices.latestPrice / last.vp;
  const pvpHistory = median(points.slice(-60).map(point => point.price / point.vp));
  const vpBefore = points.length > 60 ? points[points.length - 61].vp : null;
  const holdersBefore = points.length > 60 ? points[points.length - 61].holders : null;

  const inceptionDate = fund.inceptionDate;
  const listingDate = listedAt ?? prices.firstDate;
  const fundAge = inceptionDate ? yearsBetween(inceptionDate, now) : null;
  const listedAge = yearsBetween(listingDate, now);

  const horizons: Record<string, ReturnType<typeof publicStats>> = {};
  for (const [label, months] of [['1a', 12], ['3a', 36], ['5a', 60], ['10a', 120]] as const) {
    horizons[label] = publicStats(windowStats(points, months, cdi, ipca));
  }
  horizons.max = publicStats(windowStats(points, points.length - 1, cdi, ipca));

  return {
    ticker,
    name: fund.name,
    cnpj: fund.cnpj,
    segment: fund.segment,
    mandate: fund.mandate,
    management: fund.management,
    classification_source: 'CVM (declarado pelo fundo; pode diferir da classificação de mercado)',
    inception_date: inceptionDate,
    fund_age_years: fundAge === null ? null : round(fundAge, 1),
    listing_date: listingDate,
    listed_age_years: round(listedAge, 1),
    history: { from: points[1].key, to: last.key, months: points.length - 1 },
    market: {
      price: round(prices.latestPrice),
      price_date: prices.latestDate,
      vp_per_share: round(last.vp),
      p_vp: round(pvp),
      p_vp_median_5y: pvpHistory === null ? null : round(pvpHistory),
      p_vp_vs_median_pct: pvpHistory === null ? null : pct(pvp / pvpHistory - 1),
    },
    distributions: {
      last_12m_per_share: round(dist12),
      dividend_yield_12m_pct: pct(dist12 / prices.latestPrice),
      average_dividend_yield_5y_pct: pct(averageYield),
      months_paid_pct: pct(paidMonths),
      variation_coefficient_24m: cv24 === null ? null : round(cv24, 3),
      growth_cagr_3y_pct: pct(distGrowth),
      source: 'Maior valor, mês a mês, entre os proventos do Yahoo e a estimativa dos informes mensais da CVM (rendimento % × valor patrimonial); cada fonte tem lacunas em períodos diferentes.',
    },
    equity: {
      net_assets: last.equity === null ? null : round(last.equity, 0),
      holders: last.holders,
      holders_growth_5y_pct: last.holders && holdersBefore ? pct(last.holders / holdersBefore - 1) : null,
      vp_cagr_5y_pct: vpBefore ? pct((last.vp / vpBefore) ** (1 / 5) - 1) : null,
    },
    horizons,
    yearly_history: yearlyHistory(points),
    _points: points,
    _stats: { pvp, pvpHistory, paidMonths, cv24, distGrowth, fundAge: fundAge ?? listedAge },
  };
}

function scoreFund(analysis: Analysis, windowMonths: number, cdi: MonthlyReturns, ipca: MonthlyReturns) {
  const stats = windowStats(analysis._points, windowMonths, cdi, ipca);
  const reasons: string[] = [];
  let score = 50;
  if (!stats) return { stats, scored: buildScored(score, ['Histórico insuficiente na janela de comparação']) };

  if (stats._raw.cdiCagr !== null) {
    const excess = stats._raw.cagr - stats._raw.cdiCagr;
    score += clamp(excess / 0.05, -1, 1) * 25;
    reasons.push(`Retorno total ${excess >= 0 ? 'acima' : 'abaixo'} do CDI em ${Math.abs(excess * 100).toFixed(1).replace('.', ',')} p.p. ao ano`);
  }
  score += clamp((0.2 - Math.abs(stats._raw.drawdown)) / 0.2, -1, 1) * 10;
  reasons.push(`Queda máxima de ${Math.abs(stats._raw.drawdown * 100).toFixed(1).replace('.', ',')}% na janela`);
  if (stats._raw.volatility !== null) score += clamp((0.15 - stats._raw.volatility) / 0.1, -1, 1) * 5;

  const { paidMonths, cv24, distGrowth, pvp, fundAge } = analysis._stats;
  score += clamp((paidMonths - 0.9) / 0.1, -1, 1) * 8;
  if (paidMonths < 1) reasons.push(`Pagou rendimentos em ${(paidMonths * 100).toFixed(0)}% dos meses`);
  else reasons.push('Pagou rendimentos em todos os meses');
  if (cv24 !== null) score += cv24 < 0.1 ? 4 : cv24 > 0.3 ? -4 : 0;
  if (distGrowth !== null) {
    score += distGrowth > 0.05 ? 6 : distGrowth > 0 ? 3 : -3;
    reasons.push(`Proventos ${distGrowth >= 0 ? 'cresceram' : 'caíram'} ${Math.abs(distGrowth * 100).toFixed(1).replace('.', ',')}% ao ano em 3 anos`);
  }
  score += pvp <= 0.9 ? 6 : pvp <= 1.05 ? 3 : pvp > 1.15 ? -6 : 0;
  reasons.push(`P/VP de ${pvp.toFixed(2).replace('.', ',')}`);
  score += fundAge >= 10 ? 6 : fundAge >= 5 ? 3 : fundAge < 3 ? -6 : 0;
  reasons.push(`${fundAge.toFixed(1).replace('.', ',')} anos de história`);

  return { stats, scored: buildScored(score, reasons) };
}

export async function compareFiis(tickers: string[], years: number, amount: number) {
  const [cdi, ipca] = await Promise.all([getBcbMonthlyReturns(4391), getBcbMonthlyReturns(433)]);
  const now = new Date();

  const settled = await Promise.allSettled(tickers.map(ticker => analyzeFund(ticker, cdi, ipca, now)));
  const analyses: Analysis[] = [];
  const notFound: Array<{ ticker: string; reason: string }> = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') analyses.push(result.value);
    else notFound.push({ ticker: tickers[index], reason: result.reason instanceof Error ? result.reason.message : 'Falha ao consultar os dados' });
  });
  if (!analyses.length) throw new FiiInputError(`Nenhum fundo pôde ser analisado: ${notFound.map(item => `${item.ticker} (${item.reason})`).join('; ')}`);

  const available = Math.min(...analyses.map(analysis => analysis.history.months));
  const windowMonths = Math.min(years * 12, available);
  const scoredList = analyses.map(analysis => ({ analysis, ...scoreFund(analysis, windowMonths, cdi, ipca) }));

  const funds = scoredList.map(({ analysis, stats, scored }) => {
    const { _points, _stats, ...visible } = analysis;
    void _points; void _stats;
    const finalValue = stats ? amount * (1 + stats._raw.total) : null;
    const cdiFinal = stats?._raw.cdiTotal != null ? amount * (1 + stats._raw.cdiTotal) : null;
    const ipcaFinal = stats?._raw.ipcaTotal != null ? amount * (1 + stats._raw.ipcaTotal) : null;
    return {
      ...visible,
      score: scored.score,
      rating: scored.rating,
      rating_label: scored.rating_label,
      reasons: scored.reasons,
      common_window: publicStats(stats),
      simulation: finalValue === null ? null : {
        initial_amount: amount,
        window: `${windowMonths} meses`,
        fii_final_value: round(finalValue),
        cdi_final_value: cdiFinal === null ? null : round(cdiFinal),
        inflation_corrected_amount: ipcaFinal === null ? null : round(ipcaFinal),
        note: 'Proventos reinvestidos no fim de cada mês, sem impostos.',
      },
    };
  }).sort((a, b) => b.score - a.score);

  const ages = funds.map(fund => fund.fund_age_years ?? fund.listed_age_years);
  const best = <T>(list: T[], pick: (item: T) => number | null, direction: 'max' | 'min') => {
    const valid = list.filter(item => pick(item) !== null);
    if (!valid.length) return null;
    return valid.reduce((winner, item) => (direction === 'max' ? pick(item)! > pick(winner)! : pick(item)! < pick(winner)!) ? item : winner);
  };

  return {
    generated_at: now.toISOString(),
    comparison: {
      requested_years: years,
      window_months: windowMonths,
      window_years: round(windowMonths / 12, 1),
      limited_by_youngest_fund: windowMonths < years * 12,
      average_age_years: round(ages.reduce((sum, age) => sum + age, 0) / ages.length, 1),
      oldest: best(funds, fund => fund.fund_age_years ?? fund.listed_age_years, 'max')?.ticker ?? null,
      youngest: best(funds, fund => fund.fund_age_years ?? fund.listed_age_years, 'min')?.ticker ?? null,
    },
    ranking: funds.map((fund, index) => ({
      position: index + 1, ticker: fund.ticker, score: fund.score, rating_label: fund.rating_label,
    })),
    leaders: {
      best_total_return: best(funds, fund => fund.common_window?.total_cagr_pct ?? null, 'max')?.ticker ?? null,
      highest_dividend_yield: best(funds, fund => fund.distributions.dividend_yield_12m_pct, 'max')?.ticker ?? null,
      lowest_drawdown: best(funds, fund => fund.common_window?.max_drawdown_pct ?? null, 'max')?.ticker ?? null,
      cheapest_p_vp: best(funds, fund => fund.market.p_vp, 'min')?.ticker ?? null,
    },
    funds,
    not_found: notFound,
    disclaimer:
      'Análise quantitativa com dados históricos (CVM, B3 e Yahoo). Proventos combinam os dados do Yahoo e a estimativa dos informes mensais da CVM, sem impostos. Não constitui recomendação de investimento.',
  };
}

export async function warmFiiData() {
  await getCvmFiiData();
}
