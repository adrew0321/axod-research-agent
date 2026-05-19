/**
 * Tavily Search Client
 *
 * Oracle's primary information-gathering tool. Returns AI-optimized
 * search results — clean text content, ranked relevance, source URLs.
 *
 * Free tier: 1000 searches/month.
 * Docs: https://docs.tavily.com/
 */

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

export interface TavilySearchOptions {
  /** Search depth — 'basic' for quick mode, 'advanced' for deep research */
  searchDepth?: 'basic' | 'advanced';
  /** Number of results to return (1-20) */
  maxResults?: number;
  /** Include domain restrictions */
  includeDomains?: string[];
  /** Exclude domains */
  excludeDomains?: string[];
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilySearchResponse {
  query: string;
  results: TavilyResult[];
  responseTime: number;
}

/**
 * Run a Tavily search.
 * Throws if the API key is missing or the request fails.
 */
export async function tavilySearch(
  query: string,
  apiKey: string,
  options: TavilySearchOptions = {}
): Promise<TavilySearchResponse> {
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not configured');
  }

  const body = {
    api_key: apiKey,
    query,
    search_depth: options.searchDepth ?? 'basic',
    max_results: options.maxResults ?? 5,
    include_answer: false,
    include_raw_content: false,
    include_domains: options.includeDomains,
    exclude_domains: options.excludeDomains,
  };

  const startedAt = Date.now();
  const res = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily search failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    query: string;
    results: TavilyResult[];
  };

  return {
    query: data.query,
    results: data.results ?? [],
    responseTime: Date.now() - startedAt,
  };
}
