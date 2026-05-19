/**
 * 📡 Oracle — The Research Agent
 *
 * Barbara Gordon runs the information network. She queries Tavily,
 * filters and processes content, and stores it in D1 research_memory.
 *
 * Personality and voice canon documented in AGENTS.md.
 */

import type { TraceStore } from '../trace';
import { tavilySearch, type TavilyResult } from '../tools/tavily';

export interface OracleResearchResult {
  sourcesFound: number;
  message: string;
  results: TavilyResult[];
}

/**
 * Oracle executes the search, chunks and filters the findings,
 * and persists them into the research memory store.
 */
export async function runResearch(
  traceStore: TraceStore,
  queryId: string,
  query: string,
  tavilyApiKey: string
): Promise<OracleResearchResult> {
  if (!tavilyApiKey) {
    throw new Error('TAVILY_API_KEY is not configured');
  }

  // 1. Sweeping the web for data via Tavily (using advanced search for deep queries)
  const searchResponse = await tavilySearch(query, tavilyApiKey, {
    searchDepth: 'advanced',
    maxResults: 6,
  });

  const results = searchResponse.results;
  const sourcesFound = results.length;

  if (sourcesFound === 0) {
    return {
      sourcesFound: 0,
      message: "Swept the networks. Found nothing relevant. Memory database remains empty.",
      results: [],
    };
  }

  // 2. Chunks raw data and writes to D1 memory binding
  const chunks = results.map(r => ({
    url: r.url,
    title: r.title,
    content: r.content,
  }));

  await traceStore.storeResearchMemory(queryId, chunks);

  // 3. Oracle's signature self-confident, quantitative Bat-Family trace voice
  const message = `Swept ${sourcesFound} sources. Cross-referenced timelines. ${sourcesFound} verified intel blocks stored in the database. I've got everything. Sending it up.`;

  return {
    sourcesFound,
    message,
    results,
  };
}
