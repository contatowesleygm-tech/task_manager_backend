import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type InvestmentNewsCategory =
  | 'acoes_br'
  | 'fiis'
  | 'renda_fixa'
  | 'internacional'
  | 'cripto';

export interface InvestmentNewsArticle {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  published_at: string | null;
  categories: InvestmentNewsCategory[];
}

interface NewsFeed {
  category: InvestmentNewsCategory;
  query: string;
}

const feeds: NewsFeed[] = [
  { category: 'acoes_br', query: 'bolsa de valores Brasil ações B3 Ibovespa' },
  { category: 'fiis', query: 'fundos imobiliários FIIs Brasil mercado' },
  { category: 'renda_fixa', query: 'renda fixa CDI Selic CDB Tesouro Direto Brasil' },
  { category: 'internacional', query: 'ETFs investimentos bolsas internacionais Brasil' },
  { category: 'internacional', query: 'mercados globais juros inflação bolsas' },
  { category: 'cripto', query: 'Bitcoin Ethereum criptomoedas mercado' },
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
});
const refreshIntervalMs = 15 * 60 * 1000;
const cacheDurationMs = refreshIntervalMs;
let cached: { generatedAt: string; articles: InvestmentNewsArticle[]; warnings: string[]; expiresAt: number } | undefined;
let refreshInProgress: Promise<NonNullable<typeof cached>> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value['#text'] === 'string') return value['#text'];
  return '';
}

function items(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanSummary(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 360);
}

async function fetchFeed(feed: NewsFeed): Promise<InvestmentNewsArticle[]> {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', `${feed.query} when:7d`);
  url.searchParams.set('hl', 'pt-BR');
  url.searchParams.set('gl', 'BR');
  url.searchParams.set('ceid', 'BR:pt-419');

  const response = await fetch(url, {
    headers: { 'User-Agent': 'TaskManagerInvestmentNews/1.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Google Notícias respondeu HTTP ${response.status}.`);
  const xml = await response.text();
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error('O feed de notícias retornou XML inválido.');

  const parsed: unknown = parser.parse(xml);
  const rss = isRecord(parsed) ? parsed.rss : undefined;
  const channel = isRecord(rss) ? rss.channel : undefined;
  const feedItems = isRecord(channel) ? items(channel.item) : [];
  return feedItems.flatMap(entry => {
    if (!isRecord(entry)) return [];
    const title = text(entry.title).trim();
    const link = text(entry.link).trim();
    if (!title || !/^https?:\/\//i.test(link)) return [];
    const date = Date.parse(text(entry.pubDate));
    return [{
      id: link,
      title: cleanSummary(title),
      summary: cleanSummary(text(entry.description)),
      url: link,
      source: text(entry.source).trim() || 'Google Notícias',
      published_at: Number.isFinite(date) ? new Date(date).toISOString() : null,
      categories: [feed.category],
    }];
  });
}

async function refreshNews(): Promise<NonNullable<typeof cached>> {
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = (async () => {
    const results = await Promise.allSettled(feeds.map(fetchFeed));
    const warnings: string[] = [];
    const articlesByUrl = new Map<string, InvestmentNewsArticle>();

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        warnings.push(`Notícias de ${feeds[index].category} indisponíveis nesta atualização.`);
        return;
      }
      result.value.forEach(article => {
        const existing = articlesByUrl.get(article.url);
        if (existing) {
          existing.categories = [...new Set([...existing.categories, ...article.categories])];
        } else {
          articlesByUrl.set(article.url, article);
        }
      });
    });

    const articles = [...articlesByUrl.values()]
      .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
      .slice(0, 60);
    if (!articles.length && cached) {
      cached = {
        ...cached,
        warnings: [...warnings, 'A busca falhou; exibindo as notícias da última atualização.'],
        expiresAt: Date.now() + 60_000,
      };
      return cached;
    }
    if (!articles.length) throw new Error('Não foi possível carregar notícias das fontes consultadas.');

    const result = {
      generatedAt: new Date().toISOString(),
      articles,
      warnings,
      expiresAt: Date.now() + cacheDurationMs,
    };
    cached = result;
    return result;
  })().finally(() => {
    refreshInProgress = undefined;
  });

  return refreshInProgress;
}

export async function getInvestmentNews(forceRefresh = false) {
  const result = !forceRefresh && cached && cached.expiresAt > Date.now() ? cached : await refreshNews();
  return {
    generated_at: result.generatedAt,
    articles: result.articles,
    warnings: result.warnings,
    source: 'Google Notícias (RSS)',
    refresh_interval_minutes: refreshIntervalMs / 60_000,
  };
}

export function startInvestmentNewsRefresh(intervalMs = refreshIntervalMs) {
  void refreshNews().catch(error => console.error('Falha ao atualizar notícias de investimentos:', error));
  setInterval(() => {
    void refreshNews().catch(error => console.error('Falha ao atualizar notícias de investimentos:', error));
  }, intervalMs).unref();
}
