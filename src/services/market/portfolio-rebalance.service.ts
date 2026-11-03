import { pool } from '../../config/database';
import { getBcbMacro } from './bcb.service';
import { analyzeFiiForPortfolio } from './fii-compare.service';
import { baseAllocation } from './opportunities.service';
import type { Profile } from './scoring';

export class PortfolioInputError extends Error {}

type HoldingRow = {
  id: string; ticker: string; name: string | null; asset_type: string; fii_segment: string | null;
  quantity: number; average_price: number; current_price: number | null;
  dividend_per_share: number; frequency: string;
};

export type RateOptions = { cdbPercent: number; lciPercent: number; months: number };

const fixedIncomeTypes = ['tesouro', 'cdb', 'lci_lca', 'debenture', 'renda_fixa'];
const fiiTypes = ['fii', 'fiagro'];
const equityTypes = ['acao', 'bdr', 'etf', 'acao_us'];
const paymentsPerYear: Record<string, number> = { mensal: 12, trimestral: 4, semestral: 2, anual: 1 };
// Ganho de capital em FII: 20% sobre o lucro, sem a isenção de R$ 20 mil das ações.
const fiiCapitalGainsTax = 0.2;

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const pct = (value: number) => round(value * 100);

// Imposto de renda regressivo da renda fixa tributada.
export function incomeTaxRate(months: number): number {
  const days = months * 30;
  return days <= 180 ? 0.225 : days <= 360 ? 0.2 : days <= 720 ? 0.175 : 0.15;
}

type Macro = { selic: number; cdi: number; ipca12m: number; realRate: number };

export function fixedIncomeRates(macro: Macro, options: RateOptions) {
  const tax = incomeTaxRate(options.months);
  const cdbGross = macro.cdi * options.cdbPercent / 100;
  const products = [
    {
      id: 'cdb', name: `CDB ${options.cdbPercent}% do CDI`, gross_annual_pct: round(cdbGross),
      income_tax_pct: tax * 100, net_annual_pct: round(cdbGross * (1 - tax)),
      note: 'Imposto de renda regressivo sobre o rendimento.',
    },
    {
      id: 'lci_lca', name: `LCI/LCA ${options.lciPercent}% do CDI`, gross_annual_pct: round(macro.cdi * options.lciPercent / 100),
      income_tax_pct: 0, net_annual_pct: round(macro.cdi * options.lciPercent / 100),
      note: 'Isento de IR para pessoa física; costuma ter carência de 90 dias ou mais.',
    },
    {
      id: 'tesouro_selic', name: 'Tesouro Selic', gross_annual_pct: round(macro.cdi),
      income_tax_pct: tax * 100, net_annual_pct: round(macro.cdi * (1 - tax) - 0.2),
      note: 'Líquido de IR e da taxa de custódia da B3 (0,20% a.a., aprox.); liquidez diária.',
    },
  ];
  const best = products.reduce((winner, item) => (item.net_annual_pct > winner.net_annual_pct ? item : winner));
  return { products, best };
}

async function loadMacro(): Promise<Macro> {
  const macro = await getBcbMacro();
  return { selic: macro.selic, cdi: macro.cdi, ipca12m: macro.ipca12m, realRate: macro.realRate };
}

export async function getFixedIncomeBenchmarks(options: RateOptions) {
  const macro = await loadMacro();
  const { products, best } = fixedIncomeRates(macro, options);
  return {
    generated_at: new Date().toISOString(),
    macro: { selic: macro.selic, cdi: macro.cdi, ipca_12m: macro.ipca12m, real_rate: round(macro.realRate) },
    holding_period_months: options.months,
    products,
    best_net_option: best.id,
    equivalences: {
      fii_dividend_yield_to_match_best_pct: best.net_annual_pct,
      note: 'Proventos de FII são isentos de IR para pessoa física (cotas negociadas em bolsa, com mais de 100 cotistas). Por isso o dividend yield do FII é comparado direto com o rendimento líquido da renda fixa.',
    },
  };
}

async function loadHoldings(userId: number | string): Promise<HoldingRow[]> {
  const result = await pool.query(
    `SELECT id::text AS id, ticker, name, asset_type, fii_segment, quantity::float8 AS quantity,
            average_price::float8 AS average_price, current_price::float8 AS current_price,
            dividend_per_share::float8 AS dividend_per_share, frequency
     FROM public.dividend_holdings WHERE user_id = $1 AND is_active ORDER BY ticker`,
    [userId]
  );
  return result.rows;
}

type Recommendation = 'vender' | 'reduzir' | 'manter' | 'sem_dados';

function sellSignals(input: {
  score: number | null; dyNet: number; bestNet: number; excess: number | null; pvp: number | null;
  growth: number | null; drawdown: number | null; weight: number; taxPctOfValue: number;
}) {
  let points = 0;
  const reasons: string[] = [];
  const spread = (input.dyNet - input.bestNet) * 100;

  if (spread < 0) {
    points += 25;
    reasons.push(`Rende ${Math.abs(spread).toFixed(1).replace('.', ',')} p.p. abaixo da melhor renda fixa líquida (${(input.dyNet * 100).toFixed(1).replace('.', ',')}% contra ${(input.bestNet * 100).toFixed(1).replace('.', ',')}%)`);
  } else if (spread < 2) {
    points += 10;
    reasons.push(`Dividend yield só ${spread.toFixed(1).replace('.', ',')} p.p. acima da renda fixa, pouco prêmio pelo risco`);
  } else {
    reasons.push(`Dividend yield ${spread.toFixed(1).replace('.', ',')} p.p. acima da renda fixa líquida`);
  }
  if (input.score !== null) {
    if (input.score < 45) { points += 30; reasons.push(`Nota de qualidade baixa (${input.score})`); }
    else if (input.score < 60) { points += 15; reasons.push(`Nota de qualidade mediana (${input.score})`); }
    else reasons.push(`Nota de qualidade boa (${input.score})`);
  }
  if (input.excess !== null && input.excess < 0) {
    points += Math.min(20, Math.abs(input.excess) * 100 * 3);
    reasons.push(`Retorno total ficou ${Math.abs(input.excess * 100).toFixed(1).replace('.', ',')} p.p. ao ano abaixo do CDI no período`);
  }
  if (input.pvp !== null) {
    if (input.pvp > 1.1) { points += 10; reasons.push(`Negociado com ágio (P/VP ${input.pvp.toFixed(2).replace('.', ',')})`); }
    else if (input.pvp < 0.85) { points -= 10; reasons.push(`Negociado com desconto relevante (P/VP ${input.pvp.toFixed(2).replace('.', ',')}); vender aqui realiza o desconto`); }
  }
  if (input.growth !== null && input.growth < 0) {
    points += 8;
    reasons.push(`Proventos em queda de ${Math.abs(input.growth * 100).toFixed(1).replace('.', ',')}% ao ano em 3 anos`);
  }
  if (input.drawdown !== null && input.drawdown < -0.25) { points += 5; reasons.push(`Queda máxima de ${Math.abs(input.drawdown * 100).toFixed(0)}% no período`); }
  if (input.weight > 0.2) { points += 8; reasons.push(`Posição concentrada (${(input.weight * 100).toFixed(0)}% da carteira)`); }
  if (input.taxPctOfValue > 0.08) {
    points -= 10;
    reasons.push(`Imposto sobre o ganho seria alto (${(input.taxPctOfValue * 100).toFixed(1).replace('.', ',')}% do valor da posição)`);
  }
  return { points: Math.max(0, Math.min(100, points)), reasons };
}

export async function analyzeFiiPortfolio(
  userId: number | string,
  profile: Profile,
  options: RateOptions & { years: number; fixedIncomeTargetPct?: number }
) {
  const [macro, holdings] = await Promise.all([loadMacro(), loadHoldings(userId)]);
  if (!holdings.length) throw new PortfolioInputError('Nenhum ativo ativo encontrado na carteira.');
  const rates = fixedIncomeRates(macro, options);
  const bestNet = rates.best.net_annual_pct / 100;

  const fiiHoldings = holdings.filter(holding => fiiTypes.includes(holding.asset_type));
  const analyses = await Promise.allSettled(
    fiiHoldings.map(holding => analyzeFiiForPortfolio(holding.ticker.trim().toUpperCase(), options.years))
  );

  const valueOf = (holding: HoldingRow, livePrice?: number) =>
    holding.quantity * (livePrice ?? holding.current_price ?? holding.average_price);

  const priced = fiiHoldings.map((holding, index) => {
    const result = analyses[index];
    const live = result.status === 'fulfilled' ? result.value.fund.market.price : undefined;
    return { holding, result, price: live ?? holding.current_price ?? holding.average_price, value: valueOf(holding, live) };
  });
  const otherValue = (types: string[]) =>
    holdings.filter(holding => types.includes(holding.asset_type)).reduce((sum, holding) => sum + valueOf(holding), 0);
  const fiiValue = priced.reduce((sum, item) => sum + item.value, 0);
  const classValues = {
    renda_fixa: otherValue(fixedIncomeTypes),
    fiis: fiiValue,
    acoes: otherValue(equityTypes),
    outros: holdings
      .filter(holding => ![...fixedIncomeTypes, ...fiiTypes, ...equityTypes].includes(holding.asset_type))
      .reduce((sum, holding) => sum + valueOf(holding), 0),
  };
  const total = Object.values(classValues).reduce((sum, value) => sum + value, 0);

  const positions = priced.map(({ holding, result, price, value }) => {
    const invested = holding.average_price > 0 ? holding.quantity * holding.average_price : null;
    const gain = invested === null ? null : value - invested;
    const tax = gain !== null && gain > 0 ? gain * fiiCapitalGainsTax : 0;
    const weight = total > 0 ? value / total : 0;

    const base = {
      ticker: holding.ticker, name: holding.name, segment: holding.fii_segment,
      quantity: holding.quantity, price: round(price), market_value: round(value),
      weight_pct: pct(weight), invested: invested === null ? null : round(invested),
      gain: gain === null ? null : round(gain),
      estimated_sale_tax: round(tax),
      cost_basis_missing: invested === null,
    };

    if (result.status === 'rejected') {
      const fallbackIncome = holding.dividend_per_share * (paymentsPerYear[holding.frequency] ?? 12) * holding.quantity;
      return {
        ...base, recommendation: 'sem_dados' as Recommendation, suggested_sell_pct: 0, sell_score: null, quality_score: null,
        dividend_yield_12m_pct: value > 0 ? pct(fallbackIncome / value) : null,
        reasons: ['Não foi possível analisar este fundo com os dados de mercado; revise manualmente.'],
        _dy: value > 0 ? fallbackIncome / value : 0,
      };
    }

    const { fund, scored, stats } = result.value;
    const dy = (fund.distributions.dividend_yield_12m_pct ?? 0) / 100;
    const signals = sellSignals({
      score: scored.score, dyNet: dy, bestNet,
      excess: stats?.excess_over_cdi_pp == null ? null : stats.excess_over_cdi_pp / 100,
      pvp: fund.market.p_vp,
      growth: fund.distributions.growth_cagr_3y_pct == null ? null : fund.distributions.growth_cagr_3y_pct / 100,
      drawdown: stats?.max_drawdown_pct == null ? null : stats.max_drawdown_pct / 100,
      weight, taxPctOfValue: value > 0 ? tax / value : 0,
    });
    const recommendation: Recommendation = signals.points >= 60 ? 'vender' : signals.points >= 40 ? 'reduzir' : 'manter';

    return {
      ...base,
      recommendation,
      suggested_sell_pct: recommendation === 'vender' ? 100 : recommendation === 'reduzir' ? 50 : 0,
      sell_score: Math.round(signals.points),
      quality_score: scored.score,
      quality_rating: scored.rating_label,
      dividend_yield_12m_pct: pct(dy),
      yield_on_cost_pct: invested ? pct(value * dy / invested) : null,
      p_vp: fund.market.p_vp,
      total_cagr_pct: stats?.total_cagr_pct ?? null,
      cdi_cagr_pct: stats?.cdi_cagr_pct ?? null,
      max_drawdown_pct: stats?.max_drawdown_pct ?? null,
      analysis_window_months: result.value.windowMonths,
      reasons: signals.reasons,
      _dy: dy,
    };
  });

  const ranked = [...positions].sort((a, b) => (b.sell_score ?? -1) - (a.sell_score ?? -1));
  const fixedIncomeTarget = options.fixedIncomeTargetPct ?? baseAllocation[profile].renda_fixa;
  const plan = buildSellPlan(positions, classValues.renda_fixa, total, bestNet, fixedIncomeTarget, options.fixedIncomeTargetPct !== undefined);

  const strip = <T extends { _dy: number }>({ _dy, ...rest }: T) => { void _dy; return rest; };
  return {
    generated_at: new Date().toISOString(),
    profile,
    portfolio: {
      total_value: round(total),
      allocation_pct: Object.fromEntries(Object.entries(classValues).map(([key, value]) => [key, total > 0 ? pct(value / total) : 0])),
      fixed_income_target_pct: fixedIncomeTarget,
      fixed_income_gap_pct: total > 0 ? round(fixedIncomeTarget - classValues.renda_fixa / total * 100) : null,
      fiis_count: positions.length,
    },
    fixed_income: { holding_period_months: options.months, best_net_option: rates.best.id, products: rates.products, cdi: macro.cdi, selic: macro.selic, ipca_12m: macro.ipca12m },
    positions: ranked.map(strip),
    sell_plan: plan,
    notes: [
      'Imposto estimado a 20% sobre o lucro de cada venda (FII não tem isenção de R$ 20 mil); prejuízos em outras vendas podem ser compensados.',
      'O preço médio zerado impede o cálculo do imposto (campo cost_basis_missing).',
      'Análise quantitativa, não é recomendação de investimento; considere seus objetivos, liquidez e impostos antes de vender.',
    ],
  };
}

type PlanPosition = {
  ticker: string; market_value: number; estimated_sale_tax: number; sell_score: number | null;
  recommendation: Recommendation; suggested_sell_pct: number; _dy: number;
};

function buildSellPlan(
  positions: PlanPosition[], fixedIncomeValue: number, total: number, bestNet: number,
  targetPct: number, forceToTarget: boolean
) {
  const sales: Array<{ ticker: string; sell_pct: number; gross: number; tax: number; net: number; income_lost: number; forced: boolean }> = [];
  const push = (position: PlanPosition, fraction: number, forced: boolean) => {
    const gross = position.market_value * fraction;
    const tax = position.estimated_sale_tax * fraction;
    sales.push({
      ticker: position.ticker, sell_pct: round(fraction * 100), gross: round(gross), tax: round(tax),
      net: round(gross - tax), income_lost: round(gross * position._dy), forced,
    });
  };

  const eligible = positions.filter(position => position.sell_score !== null && position.market_value > 0);
  if (forceToTarget) {
    // Meta explícita: vende em ordem de fraqueza até o valor líquido atingir a meta de renda fixa.
    let needed = targetPct / 100 * total - fixedIncomeValue;
    for (const position of [...eligible].sort((a, b) => b.sell_score! - a.sell_score!)) {
      if (needed <= 0) break;
      const maxNet = position.market_value - position.estimated_sale_tax;
      if (maxNet <= 0) continue;
      const fraction = Math.min(1, needed / maxNet);
      push(position, fraction, position.recommendation === 'manter');
      needed -= maxNet * fraction;
    }
  } else {
    for (const position of eligible) {
      if (position.suggested_sell_pct > 0) push(position, position.suggested_sell_pct / 100, false);
    }
  }

  const gross = sales.reduce((sum, sale) => sum + sale.gross, 0);
  const tax = sales.reduce((sum, sale) => sum + sale.tax, 0);
  const net = gross - tax;
  const incomeLost = sales.reduce((sum, sale) => sum + sale.income_lost, 0);
  const incomeGained = net * bestNet;
  const totalAfter = total - tax;
  const monthlyGain = (incomeGained - incomeLost) / 12;

  return {
    mode: forceToTarget ? 'meta_renda_fixa' : 'recomendacao',
    sales,
    totals: {
      gross_proceeds: round(gross),
      estimated_tax: round(tax),
      net_proceeds: round(net),
      fii_income_lost_per_year: round(incomeLost),
      fixed_income_income_per_year: round(incomeGained),
      income_change_per_year: round(incomeGained - incomeLost),
      tax_payback_months: tax > 0 && monthlyGain > 0 ? round(tax / monthlyGain, 1) : null,
      fixed_income_share_after_pct: totalAfter > 0 ? pct((fixedIncomeValue + net) / totalAfter) : null,
    },
    message: sales.length
      ? 'Valores líquidos de imposto estimado, reaplicados na melhor opção líquida de renda fixa.'
      : forceToTarget
        ? 'A renda fixa já está na meta informada; nenhuma venda necessária.'
        : 'Nenhum fundo atingiu o critério de venda ou redução com os dados atuais.',
  };
}

type SwitchInput = { sales: Array<{ ticker: string; pct: number }>; horizons: number[] };

export async function simulateSwitch(
  userId: number | string,
  profile: Profile,
  options: RateOptions & { years: number },
  input: SwitchInput
) {
  const analysis = await analyzeFiiPortfolio(userId, profile, options);
  const macro = await loadMacro();
  const byTicker = new Map(analysis.positions.map(position => [position.ticker.toUpperCase(), position]));

  const chosen = input.sales.length
    ? input.sales.map(item => {
        const position = byTicker.get(item.ticker);
        if (!position) throw new PortfolioInputError(`Fundo ${item.ticker} não está na sua carteira.`);
        return { position, fraction: item.pct / 100 };
      })
    : analysis.positions.filter(position => position.suggested_sell_pct > 0)
        .map(position => ({ position, fraction: position.suggested_sell_pct / 100 }));
  if (!chosen.length) throw new PortfolioInputError('Nenhum fundo selecionado para a simulação.');

  const lines = chosen.map(({ position, fraction }) => {
    const gross = position.market_value * fraction;
    const tax = position.estimated_sale_tax * fraction;
    return {
      ticker: position.ticker, sell_pct: round(fraction * 100), gross, tax, net: gross - tax,
      dy: (position.dividend_yield_12m_pct ?? 0) / 100,
    };
  });
  const gross = lines.reduce((sum, line) => sum + line.gross, 0);
  const net = lines.reduce((sum, line) => sum + line.net, 0);
  const tax = gross - net;
  const weightedDy = gross > 0 ? lines.reduce((sum, line) => sum + line.gross * line.dy, 0) / gross : 0;

  const projections = input.horizons.map(months => {
    const years = months / 12;
    const ir = incomeTaxRate(months);
    const cdiGross = macro.cdi / 100;
    const growth = (annualRate: number) => (1 + annualRate) ** years - 1;
    const afterTax = (annualGross: number, taxRate: number) => 1 + growth(annualGross) * (1 - taxRate);
    const options_ = {
      cdb: net * afterTax(cdiGross * options.cdbPercent / 100, ir),
      lci_lca: net * afterTax(cdiGross * options.lciPercent / 100, 0),
      tesouro_selic: net * (afterTax(cdiGross, ir) - 0.002 * years),
    };
    const stay = gross * (1 + weightedDy) ** years;
    const bestId = (Object.keys(options_) as Array<keyof typeof options_>).reduce((a, b) => (options_[a] >= options_[b] ? a : b));
    return {
      months,
      keep_funds_value: round(stay),
      switch_values: Object.fromEntries(Object.entries(options_).map(([key, value]) => [key, round(value)])),
      best_switch_option: bestId,
      difference_best_switch_vs_keep: round(options_[bestId] - stay),
    };
  });

  const best = fixedIncomeRates(macro, options).best;
  return {
    generated_at: new Date().toISOString(),
    sold: lines.map(line => ({
      ticker: line.ticker, sell_pct: line.sell_pct, gross_proceeds: round(line.gross),
      estimated_tax: round(line.tax), net_proceeds: round(line.net), dividend_yield_12m_pct: pct(line.dy),
    })),
    totals: { gross_proceeds: round(gross), estimated_tax: round(tax), net_proceeds: round(net) },
    break_even: {
      weighted_fii_dividend_yield_pct: pct(weightedDy),
      best_fixed_income_net_pct: best.net_annual_pct,
      fii_price_appreciation_needed_per_year_pct: round(best.net_annual_pct - weightedDy * 100),
      note: 'Para valer a pena manter os fundos, eles precisariam valorizar ao menos esse percentual ao ano (além dos proventos) para empatar com a renda fixa.',
    },
    projections,
    assumptions: [
      'Mantendo os fundos: preço constante e proventos reinvestidos ao dividend yield atual.',
      'Trocando: valor líquido do imposto de venda aplicado na renda fixa, com IR regressivo conforme o prazo.',
      'Não considera mudanças futuras de juros, preços dos fundos ou liquidez/carência dos títulos.',
    ],
  };
}
