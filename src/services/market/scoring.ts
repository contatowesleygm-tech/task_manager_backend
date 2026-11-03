import { annualizedVolatility, clamp, drawdownFromHigh, periodReturn, rsi, sma } from './indicators';
import type { PriceHistory } from './yahoo-history.service';

export const assetClasses = ['renda_fixa', 'acoes_br', 'fiis', 'internacional', 'cripto'] as const;
export type AssetClass = (typeof assetClasses)[number];
export const profiles = ['conservador', 'moderado', 'arrojado'] as const;
export type Profile = (typeof profiles)[number];
export type Rating = 'otimo' | 'bom' | 'neutro' | 'atencao' | 'evitar';

export const classLabels: Record<AssetClass, string> = {
  renda_fixa: 'Renda fixa',
  acoes_br: 'Ações Brasil',
  fiis: 'Fundos imobiliários',
  internacional: 'Internacional',
  cripto: 'Criptomoedas',
};

export type AssetMetrics = {
  price: number;
  momentum3m?: number;
  momentum12m?: number;
  distanceFromSma200?: number;
  rsi14?: number;
  volatility?: number;
  drawdown?: number;
  dividendYield?: number;
};

export type Macro = {
  selic?: number;
  cdi?: number;
  ipca12m?: number;
  realRate?: number;
  ibovVsSma200?: number;
  vix?: number;
  usdBrlMomentum3m?: number;
};

export type Scored = { score: number; rating: Rating; rating_label: string; reasons: string[] };

const ratingLabels: Record<Rating, string> = {
  otimo: 'Ótimo', bom: 'Bom', neutro: 'Neutro', atencao: 'Atenção', evitar: 'Evitar',
};

// Referências por classe: o que é "movimento forte" e "volatilidade normal" muda bastante entre elas.
const references: Record<AssetClass, { momentum: number; trend: number; volatility: number; stretched: number }> = {
  renda_fixa: { momentum: 1, trend: 1, volatility: 1, stretched: 1 },
  acoes_br: { momentum: 0.15, trend: 0.1, volatility: 0.3, stretched: 0.3 },
  fiis: { momentum: 0.08, trend: 0.05, volatility: 0.15, stretched: 0.15 },
  internacional: { momentum: 0.12, trend: 0.08, volatility: 0.25, stretched: 0.25 },
  cripto: { momentum: 0.4, trend: 0.3, volatility: 0.7, stretched: 0.8 },
};

const volatilityPenalty: Record<Profile, number> = { conservador: 1.5, moderado: 1, arrojado: 0.5 };

export function toRating(score: number): Rating {
  if (score >= 80) return 'otimo';
  if (score >= 65) return 'bom';
  if (score >= 45) return 'neutro';
  if (score >= 30) return 'atencao';
  return 'evitar';
}

export function buildScored(rawScore: number, reasons: string[]): Scored {
  const score = Math.round(clamp(rawScore, 0, 100));
  const rating = toRating(score);
  return { score, rating, rating_label: ratingLabels[rating], reasons };
}

const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits).replace('.', ',')}%`;

export function computeMetrics(history: PriceHistory): AssetMetrics {
  const { closes } = history;
  const price = closes[closes.length - 1];
  const sma200 = sma(closes, Math.min(200, closes.length));
  const yearAgo = Date.now() / 1000 - 365 * 24 * 60 * 60;
  const paid = history.dividends.filter(item => item.date >= yearAgo).reduce((sum, item) => sum + item.amount, 0);

  return {
    price,
    momentum3m: periodReturn(closes, 63),
    momentum12m: periodReturn(closes, Math.min(252, closes.length - 1)),
    distanceFromSma200: sma200 ? price / sma200 - 1 : undefined,
    rsi14: rsi(closes),
    volatility: annualizedVolatility(closes),
    drawdown: drawdownFromHigh(closes),
    dividendYield: paid > 0 ? paid / price : undefined,
  };
}

export function scoreAsset(metrics: AssetMetrics, assetClass: AssetClass, profile: Profile): Scored {
  const ref = references[assetClass];
  const reasons: string[] = [];
  let score = 50;

  if (metrics.momentum3m !== undefined) {
    score += clamp(metrics.momentum3m / ref.momentum, -1, 1) * 20;
    reasons.push(`Retorno de 3 meses: ${pct(metrics.momentum3m)}`);
  }
  if (metrics.momentum12m !== undefined) {
    score += clamp(metrics.momentum12m / (ref.momentum * 2), -1, 1) * 10;
    reasons.push(`Retorno de 12 meses: ${pct(metrics.momentum12m)}`);
  }
  if (metrics.distanceFromSma200 !== undefined) {
    const distance = metrics.distanceFromSma200;
    score += clamp(distance / ref.trend, -1, 1) * 10;
    if (distance > ref.stretched) {
      score -= 6;
      reasons.push(`Preço ${pct(distance, 0)} acima da média de 200 dias (esticado)`);
    } else {
      reasons.push(`Preço ${pct(Math.abs(distance), 0)} ${distance >= 0 ? 'acima' : 'abaixo'} da média de 200 dias`);
    }
  }
  if (metrics.rsi14 !== undefined) {
    if (metrics.rsi14 > 70) {
      score -= 10;
      reasons.push(`RSI ${metrics.rsi14.toFixed(0)}: sobrecomprado`);
    } else if (metrics.rsi14 < 30) {
      score += 8;
      reasons.push(`RSI ${metrics.rsi14.toFixed(0)}: sobrevendido`);
    }
  }
  if (metrics.volatility !== undefined) {
    const adjustment = clamp((1 - metrics.volatility / ref.volatility) * 10, -12, 6);
    score += adjustment < 0 ? adjustment * volatilityPenalty[profile] : adjustment;
    reasons.push(`Volatilidade anual: ${pct(metrics.volatility, 0)}`);
  }
  if (metrics.dividendYield !== undefined && (assetClass === 'fiis' || assetClass === 'acoes_br')) {
    const [high, medium] = assetClass === 'fiis' ? [0.1, 0.08] : [0.08, 0.05];
    if (metrics.dividendYield >= high) score += 10;
    else if (metrics.dividendYield >= medium) score += 5;
    reasons.push(`Dividend yield 12 meses: ${pct(metrics.dividendYield)}`);
  }

  return buildScored(score, reasons);
}

export function scoreFixedIncome(macro: Macro, profile: Profile): Scored {
  if (macro.realRate === undefined || macro.cdi === undefined || macro.ipca12m === undefined) {
    return buildScored(50, ['Dados do Banco Central indisponíveis']);
  }
  let score = 50 + (macro.realRate - 4) * 12;
  if (profile === 'conservador') score += 5;
  const reasons = [
    `CDI: ${macro.cdi.toFixed(2).replace('.', ',')}% a.a.`,
    `IPCA 12 meses: ${macro.ipca12m.toFixed(2).replace('.', ',')}%`,
    `Juro real (CDI − IPCA): ${macro.realRate.toFixed(2).replace('.', ',')}% a.a.`,
  ];
  if (macro.selic !== undefined) reasons.unshift(`Selic meta: ${macro.selic.toFixed(2).replace('.', ',')}% a.a.`);
  return buildScored(score, reasons);
}

// Ajusta a nota de uma classe de risco pelo contexto macro e pelo perfil.
export function scoreClass(assetScores: number[], assetClass: AssetClass, macro: Macro, profile: Profile): Scored {
  const top = [...assetScores].sort((a, b) => b - a).slice(0, 5);
  if (!top.length) return buildScored(50, ['Sem dados suficientes para análise']);

  let score = top.reduce((sum, value) => sum + value, 0) / top.length;
  const reasons = [`Média dos ${top.length} melhores ativos analisados: ${score.toFixed(0)}`];
  const adjust = (points: number, reason: string) => {
    score += points;
    reasons.push(`${points > 0 ? '+' : ''}${points} ${reason}`);
  };

  if (macro.vix !== undefined) {
    const weight = assetClass === 'cripto' ? 2 : 1;
    if (macro.vix > 30) adjust(-8 * weight, `VIX em ${macro.vix.toFixed(0)}: estresse alto no mercado`);
    else if (macro.vix > 22) adjust(-4 * weight, `VIX em ${macro.vix.toFixed(0)}: volatilidade elevada`);
    else if (macro.vix < 16) adjust(2, `VIX em ${macro.vix.toFixed(0)}: mercado calmo`);
  }
  if (assetClass === 'acoes_br' && macro.ibovVsSma200 !== undefined) {
    if (macro.ibovVsSma200 < 0) adjust(-5, 'Ibovespa abaixo da média de 200 dias');
    else adjust(3, 'Ibovespa acima da média de 200 dias');
  }
  if (assetClass === 'internacional' && macro.usdBrlMomentum3m !== undefined && macro.usdBrlMomentum3m > 0.08) {
    adjust(-3, 'Dólar subiu forte no trimestre (entrada mais cara)');
  }
  if (macro.realRate !== undefined) {
    if (macro.realRate > 8) adjust(assetClass === 'fiis' ? -6 : -4, `Juro real alto (${macro.realRate.toFixed(1).replace('.', ',')}%) compete com ativos de risco`);
    else if (macro.realRate < 4) adjust(3, 'Juro real baixo favorece ativos de risco');
  }
  if (profile === 'conservador') adjust(assetClass === 'cripto' ? -15 : -5, 'Perfil conservador');
  else if (profile === 'arrojado' && assetClass !== 'cripto') adjust(3, 'Perfil arrojado');

  return buildScored(score, reasons);
}
