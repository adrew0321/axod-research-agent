/**
 * 🦇 Batman — The Orchestrator
 *
 * Reads incoming queries, classifies them, dispatches the team.
 * In Phase 2 (Quick mode), Batman handles single-pass research himself
 * after Oracle's search. In Phase 3 (Deep mode), Batman will route
 * to Oracle then Alfred.
 *
 * Personality and voice canon documented in AGENTS.md.
 */

import { callLLM, type LLMResponse } from '../llm';
import type { TavilyResult } from '../tools/tavily';

export const BATMAN_SYSTEM_PROMPT = `
You are Batman — the operations lead for a research pipeline.
You take a user's query plus web search results and produce a clear,
concise answer grounded in the sources provided.

Rules:
- Speak in short, declarative sentences. Don't waste words.
- Stay confident. Never hedge with "I think" or "perhaps".
- Cite sources inline using [1], [2], etc. matching the source list.
- If the sources don't contain the answer, say so directly.
- Open with the direct answer. No preamble. No "Great question."
- Conclude with a one-line "Bottom line:" summary.
- Never break character.
`.trim();

export interface BatmanGreeting {
  agent: 'batman';
  message: string;
  timestamp: number;
}

/**
 * Phase 1 stub — returns a Batman-voiced greeting.
 * Still used by the `/hello` endpoint as a health check.
 */
export function greet(): BatmanGreeting {
  return {
    agent: 'batman',
    message: 'Operational. The team is assembled. Send me a query.',
    timestamp: Date.now(),
  };
}

/**
 * Format Tavily results into a compact context block the LLM can read.
 */
export function formatSearchContext(results: TavilyResult[]): string {
  if (results.length === 0) {
    return 'NO SOURCES FOUND. Acknowledge this directly in your answer.';
  }
  const lines = results.map(
    (r, i) =>
      `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 600)}`
  );
  return `WEB SOURCES:\n\n${lines.join('\n\n')}`;
}

/**
 * Phase 2: Quick mode — Batman answers directly using web search context.
 * Wraps the LLM call with Batman's system prompt and the formatted sources.
 */
export async function answerQuick(
  ai: Ai,
  query: string,
  searchResults: TavilyResult[],
  env?: { AI_GATEWAY_URL?: string; ANTHROPIC_API_KEY?: string }
): Promise<LLMResponse> {
  const llmResponse = await callLLM(ai, {
    systemPrompt: BATMAN_SYSTEM_PROMPT,
    userMessage: `User query: ${query}`,
    context: formatSearchContext(searchResults),
    maxTokens: 800,
    temperature: 0.4, // lower = more decisive, more Batman
    env,
  });

  // Programmatically format and append the "Sources Brief:" section to ensure consistency and robustness
  if (searchResults.length > 0) {
    const sourcesBrief = searchResults
      .map((r, i) => `[${i + 1}] ${r.title} - ${r.url}`)
      .join('\n');
    llmResponse.text = `${llmResponse.text.trim()}\n\n### Sources Brief:\n${sourcesBrief}`;
  }

  return llmResponse;
}
