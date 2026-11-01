export const frequencies = ['mensal', 'trimestral', 'semestral', 'anual'] as const;
export type Frequency = (typeof frequencies)[number];
export type QuoteMarket = 'b3' | 'yahoo' | null;

export const investmentTypes = {
  fii: { label: 'Fundo Imobiliário', frequency: 'mensal', quote: 'b3' },
  fiagro: { label: 'Fiagro', frequency: 'mensal', quote: 'b3' },
  acao: { label: 'Ação', frequency: 'trimestral', quote: 'b3' },
  bdr: { label: 'BDR', frequency: 'trimestral', quote: 'b3' },
  etf: { label: 'ETF', frequency: 'trimestral', quote: 'b3' },
  fundo: { label: 'Fundo de investimento', frequency: 'mensal', quote: null },
  tesouro: { label: 'Tesouro Direto', frequency: 'semestral', quote: null },
  cdb: { label: 'CDB', frequency: 'mensal', quote: null },
  lci_lca: { label: 'LCI/LCA', frequency: 'mensal', quote: null },
  debenture: { label: 'Debênture', frequency: 'semestral', quote: null },
  previdencia: { label: 'Previdência', frequency: 'mensal', quote: null },
  cripto: { label: 'Criptomoeda', frequency: 'mensal', quote: 'yahoo' },
  acao_us: { label: 'Ação internacional', frequency: 'trimestral', quote: 'yahoo' },
  renda_fixa: { label: 'Renda fixa', frequency: 'mensal', quote: null },
  outro: { label: 'Outro', frequency: 'mensal', quote: null },
} as const satisfies Record<string, { label: string; frequency: Frequency; quote: QuoteMarket }>;

export type AssetType = keyof typeof investmentTypes;
export const assetTypes = Object.keys(investmentTypes) as AssetType[];
export const fiiLikeTypes: AssetType[] = ['fii', 'fiagro'];
export const B3_ASSET_TYPES = assetTypes.filter(type => investmentTypes[type].quote === 'b3');
export const AUTO_QUOTE_TYPES = assetTypes.filter(type => investmentTypes[type].quote !== null);

export function defaultFrequency(assetType: AssetType): Frequency {
  return investmentTypes[assetType].frequency;
}

export function isFiiLike(assetType: string): boolean {
  return fiiLikeTypes.includes(assetType as AssetType);
}

export function catalog() {
  return assetTypes.map(id => ({
    id,
    label: investmentTypes[id].label,
    default_frequency: investmentTypes[id].frequency,
    auto_quote: investmentTypes[id].quote !== null,
    quote_market: investmentTypes[id].quote,
    uses_fii_segment: isFiiLike(id),
  }));
}
