import {
  combineReturns, getBcbMonthlyLevels, getBcbMonthlyReturns, getYahooMonthlyLevels, levelsToReturns, shiftMonth,
  type MonthlyReturns,
} from './historical-data.service';
import type { Profile } from './scoring';

export class BacktestInputError extends Error {}

export type BacktestInput = {
  initialAmount: number;
  startYear: number;
  monthlyContribution: number;
  indexContributionToInflation: boolean;
  profile: Profile;
  portfolio?: Record<string, number>;
  assetFilter?: string[];
};

type Component = { id: string; name: string; note?: string; returns: MonthlyReturns };

export const earliestStartYear = 2004;

const defaultPortfolios: Record<Profile, Record<string, number>> = {
  conservador: { cdi: 70, ibovespa: 10, sp500: 10, ouro: 10 },
  moderado: { cdi: 40, ibovespa: 25, sp500: 25, ouro: 10 },
  arrojado: { cdi: 15, ibovespa: 40, sp500: 35, ouro: 10 },
};

const crises = [
  { id: 'crise_2008', name: 'Crise financeira global (Lehman)', start: '2008-05', end: '2009-02' },
  { id: 'brasil_2014_2015', name: 'Recessão e crise política no Brasil', start: '2014-09', end: '2015-12' },
  { id: 'covid_2020', name: 'Pandemia de Covid-19', start: '2020-01', end: '2020-03' },
  { id: 'juros_2021_2022', name: 'Inflação global e alta de juros', start: '2021-06', end: '2022-06' },
];

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const pct = (value: number) => round(value * 100);
const brl = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const ratingLabels = { otimo: 'Ótimo', bom: 'Bom', neutro: 'Neutro', atencao: 'Atenção', evitar: 'Evitar' } as const;

function realRating(realCagr: number) {
  const key = realCagr >= 0.06 ? 'otimo' : realCagr >= 0.03 ? 'bom' : realCagr >= 0 ? 'neutro' : realCagr >= -0.03 ? 'atencao' : 'evitar';
  return { rating: key, rating_label: ratingLabels[key] };
}

async function loadComponents() {
  const [cdi, selic, ipca, tr, bvsp, sp500, fx, gold, btc] = await Promise.allSettled([
    getBcbMonthlyReturns(4391),
    getBcbMonthlyReturns(4390),
    getBcbMonthlyReturns(433),
    getBcbMonthlyReturns(7811),
    getYahooMonthlyLevels('^BVSP'),
    getYahooMonthlyLevels('^SP500TR'),
    getBcbMonthlyLevels(3696),
    getYahooMonthlyLevels('GC=F'),
    getYahooMonthlyLevels('BTC-USD'),
  ]);

  if (cdi.status === 'rejected' || ipca.status === 'rejected') {
    throw new Error('Não foi possível obter CDI e IPCA do Banco Central para a simulação.');
  }

  const components: Component[] = [{ id: 'cdi', name: 'Renda fixa (100% do CDI)', returns: cdi.value }];
  const unavailable: Array<{ id: string; reason: string }> = [];

  if (selic.status === 'fulfilled' && tr.status === 'fulfilled') {
    const poupanca: MonthlyReturns = new Map();
    for (const [key, selicMonth] of selic.value) {
      const trMonth = tr.value.get(key);
      if (trMonth === undefined) continue;
      // Regra da poupança: 0,5% a.m. + TR com Selic > 8,5% a.a.; senão 70% da Selic + TR.
      const selicYear = (1 + selicMonth) ** 12 - 1;
      const base = selicYear > 0.085 ? 0.005 : 0.7 * selicMonth;
      poupanca.set(key, (1 + base) * (1 + trMonth) - 1);
    }
    components.push({ id: 'poupanca', name: 'Poupança (estimada)', note: 'Calculada pela regra oficial a partir de Selic e TR.', returns: poupanca });
  } else unavailable.push({ id: 'poupanca', reason: 'Selic/TR indisponíveis' });

  const usdBrl = fx.status === 'fulfilled' ? levelsToReturns(fx.value) : undefined;
  if (bvsp.status === 'fulfilled') {
    components.push({
      id: 'ibovespa', name: 'Ibovespa', returns: levelsToReturns(bvsp.value),
      note: 'Índice de preço: não inclui dividendos, então subestima o retorno de quem recebeu proventos.',
    });
  } else unavailable.push({ id: 'ibovespa', reason: 'Fonte indisponível' });

  if (usdBrl) components.push({ id: 'dolar', name: 'Dólar (PTAX)', returns: usdBrl });
  else unavailable.push({ id: 'dolar', reason: 'Fonte indisponível' });

  const inBrl = (id: string, name: string, levels: PromiseSettledResult<Map<string, number>>, note: string) => {
    if (levels.status === 'fulfilled' && usdBrl) {
      components.push({ id, name, note, returns: combineReturns(levelsToReturns(levels.value), usdBrl) });
    } else unavailable.push({ id, reason: 'Fonte indisponível' });
  };
  inBrl('sp500', 'S&P 500 (em reais)', sp500, 'Retorno total (com dividendos) em dólar convertido para reais, sem impostos.');
  inBrl('ouro', 'Ouro (em reais)', gold, 'Ouro em dólar convertido para reais.');
  inBrl('bitcoin', 'Bitcoin (em reais)', btc, 'Bitcoin em dólar convertido para reais.');

  return { components, unavailable, ipca: ipca.value };
}

function monthRange(start: string, end: string): string[] {
  const months: string[] = [];
  for (let key = start; key <= end; key = shiftMonth(key, 1)) months.push(key);
  return months;
}

type Simulation = { values: number[]; invested: number[] };

function simulate(
  months: string[], returns: number[][], weights: number[], initial: number,
  contribution: (index: number) => number
): Simulation {
  let holdings = weights.map(weight => initial * weight);
  const values = [initial];
  const invested = [initial];
  months.forEach((key, index) => {
    holdings = holdings.map((holding, asset) => holding * (1 + returns[asset][index]));
    const extra = contribution(index);
    holdings = holdings.map((holding, asset) => holding + extra * weights[asset]);
    // Rebalanceamento anual, em dezembro.
    if (key.endsWith('-12') && weights.length > 1) {
      const total = holdings.reduce((sum, holding) => sum + holding, 0);
      holdings = weights.map(weight => total * weight);
    }
    values.push(holdings.reduce((sum, holding) => sum + holding, 0));
    invested.push(invested[invested.length - 1] + extra);
  });
  return { values, invested };
}

function monthlyIrr(initial: number, contributions: number[], finalValue: number): number {
  const npv = (rate: number) =>
    -initial - contributions.reduce((sum, value, index) => sum + value / (1 + rate) ** (index + 1), 0)
    + finalValue / (1 + rate) ** contributions.length;
  let low = -0.5;
  let high = 1;
  for (let step = 0; step < 100; step++) {
    const mid = (low + high) / 2;
    if (npv(mid) > 0) low = mid; else high = mid;
  }
  return (1 + (low + high) / 2) ** 12 - 1;
}

function drawdown(values: number[], labelOf: (index: number) => string) {
  let peakIndex = 0;
  let worst = { depth: 0, peak: 0, trough: 0 };
  values.forEach((value, index) => {
    if (value > values[peakIndex]) peakIndex = index;
    const depth = value / values[peakIndex] - 1;
    if (depth < worst.depth) worst = { depth, peak: peakIndex, trough: index };
  });
  if (worst.depth === 0) return { max_drawdown_pct: 0, peak: null, trough: null, recovered_at: null, months_to_recover: null };
  const recoveredIndex = values.findIndex((value, index) => index > worst.trough && value >= values[worst.peak]);
  return {
    max_drawdown_pct: pct(worst.depth),
    peak: labelOf(worst.peak),
    trough: labelOf(worst.trough),
    recovered_at: recoveredIndex >= 0 ? labelOf(recoveredIndex) : null,
    months_to_recover: recoveredIndex >= 0 ? recoveredIndex - worst.trough : null,
  };
}

export function runBacktest(input: BacktestInput, data: Awaited<ReturnType<typeof loadComponents>>) {
  const startKey = `${input.startYear}-01`;
  const unavailable = [...data.unavailable];
  let usable = data.components.filter(component => {
    const first = [...component.returns.keys()].sort()[0];
    if (first > startKey) {
      unavailable.push({ id: component.id, reason: `Histórico disponível apenas a partir de ${first}` });
      return false;
    }
    return true;
  });
  if (input.assetFilter?.length) {
    const unknown = input.assetFilter.filter(id => !data.components.some(component => component.id === id));
    if (unknown.length) throw new BacktestInputError(`Ativos desconhecidos: ${unknown.join(', ')}.`);
    usable = usable.filter(component => input.assetFilter!.includes(component.id));
  }

  const lastKey = (returns: MonthlyReturns) => [...returns.keys()].sort().slice(-1)[0];
  const endKey = [lastKey(data.ipca), ...usable.map(component => lastKey(component.returns))].sort()[0];
  const months = monthRange(startKey, endKey);
  if (months.length < 12) throw new BacktestInputError('Período curto demais: escolha um ano inicial anterior.');

  const complete = (returns: MonthlyReturns) => months.every(key => returns.has(key));
  usable = usable.filter(component => {
    if (complete(component.returns)) return true;
    unavailable.push({ id: component.id, reason: 'Série histórica incompleta no período' });
    return false;
  });
  if (!complete(data.ipca)) throw new Error('Série de IPCA incompleta no período.');

  const ipcaIndex = [1];
  months.forEach(key => ipcaIndex.push(ipcaIndex[ipcaIndex.length - 1] * (1 + data.ipca.get(key)!)));
  const ipcaTotal = ipcaIndex[months.length] - 1;
  const years = months.length / 12;
  const labelOf = (index: number) => (index === 0 ? shiftMonth(startKey, -1) : months[index - 1]);

  const portfolioWeights = input.portfolio ?? defaultPortfolios[input.profile];
  const portfolioIds = Object.keys(portfolioWeights).filter(id => usable.some(component => component.id === id));
  if (input.portfolio) {
    const missing = Object.keys(input.portfolio).filter(id => !portfolioIds.includes(id));
    if (missing.length) throw new BacktestInputError(`Ativos da carteira indisponíveis para este período: ${missing.join(', ')}.`);
  }
  const weightTotal = portfolioIds.reduce((sum, id) => sum + portfolioWeights[id], 0);
  if (!portfolioIds.length || weightTotal <= 0) throw new BacktestInputError('Carteira sem ativos disponíveis no período.');
  if (input.portfolio && Math.abs(weightTotal - 100) > 0.01) throw new BacktestInputError('Os pesos da carteira devem somar 100.');

  const series = [
    ...usable.map(component => ({ ...component, kind: 'ativo' as const, ids: [component.id], weights: [1] })),
    {
      id: 'carteira', name: `Carteira ${input.profile}`, kind: 'carteira' as const,
      note: 'Rebalanceada anualmente em dezembro; aportes divididos conforme os pesos.',
      ids: portfolioIds, weights: portfolioIds.map(id => portfolioWeights[id] / weightTotal),
      returns: new Map() as MonthlyReturns,
    },
  ];

  const contributionAt = (index: number) =>
    input.monthlyContribution * (input.indexContributionToInflation ? ipcaIndex[index + 1] : 1);

  const results = series.map(item => {
    const matrix = item.ids.map(id => months.map(key => usable.find(component => component.id === id)!.returns.get(key)!));
    const without = simulate(months, matrix, item.weights, input.initialAmount, () => 0);
    const withContribution = simulate(months, matrix, item.weights, input.initialAmount, contributionAt);

    const monthly = without.values.slice(1).map((value, index) => value / without.values[index] - 1);
    const mean = monthly.reduce((sum, value) => sum + value, 0) / monthly.length;
    const volatility = Math.sqrt(monthly.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (monthly.length - 1)) * Math.sqrt(12);

    const finalWithout = without.values[months.length];
    const cagr = (finalWithout / input.initialAmount) ** (1 / years) - 1;
    const realCagr = (1 + cagr) / (1 + ipcaTotal) ** (1 / years) - 1;

    const yearly = [...new Set(months.map(key => key.slice(0, 4)))].map(year => {
      const positions = months.map((key, index) => ({ key, index })).filter(item => item.key.startsWith(year));
      const from = positions[0].index;
      const to = positions[positions.length - 1].index + 1;
      return {
        year: Number(year),
        partial: positions.length < 12,
        return_pct: pct(without.values[to] / without.values[from] - 1),
        value_without_contributions: round(without.values[to]),
        value_with_contributions: round(withContribution.values[to]),
      };
    });

    const finalWith = withContribution.values[months.length];
    const totalInvested = withContribution.invested[months.length];
    const contributions = months.map((_, index) => contributionAt(index));

    return {
      id: item.id,
      name: item.name,
      kind: item.kind,
      note: item.note,
      weights_pct: item.kind === 'carteira' ? Object.fromEntries(item.ids.map((id, index) => [id, round(item.weights[index] * 100)])) : undefined,
      ...realRating(realCagr),
      preserved_purchasing_power: realCagr >= 0,
      without_contributions: {
        final_value: round(finalWithout),
        multiple: round(finalWithout / input.initialAmount),
        final_value_in_initial_purchasing_power: round(finalWithout / ipcaIndex[months.length]),
        cagr_pct: pct(cagr),
        real_cagr_pct: pct(realCagr),
        annual_volatility_pct: pct(volatility),
        ...drawdown(without.values, labelOf),
        best_year: yearly.filter(item => !item.partial).sort((a, b) => b.return_pct - a.return_pct)[0] ?? null,
        worst_year: yearly.filter(item => !item.partial).sort((a, b) => a.return_pct - b.return_pct)[0] ?? null,
        negative_years: yearly.filter(item => !item.partial && item.return_pct < 0).length,
      },
      with_contributions: {
        total_invested: round(totalInvested),
        final_value: round(finalWith),
        gain: round(finalWith - totalInvested),
        return_on_invested_pct: pct(finalWith / totalInvested - 1),
        annual_irr_pct: pct(monthlyIrr(input.initialAmount, contributions, finalWith)),
        final_value_in_initial_purchasing_power: round(finalWith / ipcaIndex[months.length]),
      },
      yearly,
      _values: without.values,
    };
  });

  const eligibleCrises = crises.filter(crisis => months.includes(crisis.start) && months.includes(crisis.end));
  const crisisResults = eligibleCrises.map(crisis => {
    const from = months.indexOf(crisis.start);
    const to = months.indexOf(crisis.end) + 1;
    return {
      id: crisis.id,
      name: crisis.name,
      period: { start: crisis.start, end: crisis.end },
      inflation_pct: pct(ipcaIndex[to] / ipcaIndex[from] - 1),
      results: results.map(item => {
        const values = item._values;
        let peak = values[from];
        let worst = 0;
        for (let index = from; index <= to; index++) {
          peak = Math.max(peak, values[index]);
          worst = Math.min(worst, values[index] / peak - 1);
        }
        return {
          id: item.id,
          name: item.name,
          return_pct: pct(values[to] / values[from] - 1),
          worst_drop_pct: pct(worst),
          value_at_start: round(values[from]),
          value_at_end: round(values[to]),
        };
      }).sort((a, b) => b.return_pct - a.return_pct),
    };
  });

  const assets = results.filter(item => item.kind === 'ativo');
  const portfolio = results.find(item => item.kind === 'carteira')!;
  const ranked = [...assets].sort((a, b) => b.without_contributions.final_value - a.without_contributions.final_value);
  const lostToInflation = assets.filter(item => !item.preserved_purchasing_power).map(item => item.name);
  const highlights = [
    `${brl(input.initialAmount)} em ${input.startYear} viraram ${brl(ranked[0].without_contributions.final_value)} em ${ranked[0].name} (${ranked[0].without_contributions.multiple}x), o melhor resultado do período.`,
    `O pior foi ${ranked[ranked.length - 1].name}: ${brl(ranked[ranked.length - 1].without_contributions.final_value)} (${ranked[ranked.length - 1].without_contributions.multiple}x).`,
    `Para manter o poder de compra, ${brl(input.initialAmount)} de ${input.startYear} precisariam valer ${brl(input.initialAmount * ipcaIndex[months.length])} hoje (IPCA de ${pct(ipcaTotal)}%).`,
    lostToInflation.length ? `Perderam para a inflação: ${lostToInflation.join(', ')}.` : 'Todos os ativos analisados superaram a inflação no período.',
  ];
  const dd = portfolio.without_contributions;
  if (dd.peak && dd.trough) {
    highlights.push(`A carteira chegou a cair ${Math.abs(dd.max_drawdown_pct)}% entre ${dd.peak} e ${dd.trough}${dd.months_to_recover !== null ? `, recuperando em ${dd.months_to_recover} meses` : ' e ainda não recuperou o topo anterior'}.`);
  }
  if (input.monthlyContribution > 0) {
    highlights.push(`Com aportes de ${brl(input.monthlyContribution)}/mês, a carteira soma ${brl(portfolio.with_contributions.total_invested)} investidos e termina com ${brl(portfolio.with_contributions.final_value)}.`);
  }

  const strip = ({ _values, ...rest }: (typeof results)[number]) => rest;
  return {
    generated_at: new Date().toISOString(),
    parameters: {
      initial_amount: input.initialAmount,
      monthly_contribution: input.monthlyContribution,
      contribution_indexed_to_ipca: input.indexContributionToInflation,
      start_year: input.startYear,
      period: { start: months[0], end: months[months.length - 1], months: months.length, years: round(years, 1) },
      profile: input.profile,
    },
    inflation: {
      ipca_accumulated_pct: pct(ipcaTotal),
      ipca_average_annual_pct: pct((1 + ipcaTotal) ** (1 / years) - 1),
      initial_amount_corrected_to_today: round(input.initialAmount * ipcaIndex[months.length]),
      initial_amount_today_in_start_purchasing_power: round(input.initialAmount / ipcaIndex[months.length]),
    },
    highlights,
    portfolio: strip(portfolio),
    assets: ranked.map(strip),
    crises: crisisResults,
    unavailable,
    disclaimer:
      'Simulação histórica com dados passados. Não considera impostos, taxas nem custos de corretagem, e rentabilidade passada não garante resultados futuros.',
  };
}

export async function getBacktest(input: BacktestInput) {
  return runBacktest(input, await loadComponents());
}
