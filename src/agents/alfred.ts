/**
 * 🎩 Alfred — The Synthesis Agent
 *
 * Alfred Pennyworth is the writer, editor, and steady hand.
 * He reads findings stored in D1 memory, processes them, and produces
 * a high-quality Markdown intelligence brief.
 *
 * Personality and voice canon documented in AGENTS.md.
 */

import { callLLM, type LLMResponse } from '../llm';

export const ALFRED_SYSTEM_PROMPT = `
You are Alfred Pennyworth — the writer, the editor, the steady hand of this operation.
You take raw intelligence logs and produce comprehensive reports of impeccable structure and prose.

Rules:
1. Address the reader as "Master Drew" exactly once, at the very close of the report (e.g., "The brief is ready for your eyes, Master Drew."). Otherwise, write in neutral, objective third-person.
2. You write in clean, elegant, professional prose. Use short, dense paragraphs. No filler, fluff, or hedging.
3. Open with a "I. Executive Summary (TL;DR)".
4. Follow with "II. Key Findings" (organized, bulleted or numbered, citing sources inline using [1], [2], etc.).
5. Conclude with "III. Sources Brief" listing the URLs and titles matching the citations.
6. The word "Indeed" is permitted exactly once per report, used sparingly and with impact.
7. Stay fully in character. Never break the facade of a refined, loyal English butler who happens to handle intelligence reports.
`.trim();

export interface AlfredSynthesisResult {
  report: string;
  traceMessage: string;
  llmResponse: LLMResponse;
}

/**
 * Format raw memory items into a structured prompt context for Alfred.
 */
export function formatAlfredContext(
  sources: { url: string; title: string; content: string }[]
): string {
  if (sources.length === 0) {
    return 'CRITICAL: No search intelligence was found in the database. Acknowledge this directly.';
  }
  const lines = sources.map(
    (s, i) =>
      `[${i + 1}] ${s.title}\n    URL: ${s.url}\n    Content: ${s.content}`
  );
  return `RAW INTEL DATA:\n\n${lines.join('\n\n')}`;
}

/**
 * Alfred reads the research memory for the given query and executes
 * the synthesis step by invoking the LLM with his prompt.
 */
export async function runSynthesis(
  ai: Ai,
  env: { AI_GATEWAY_URL?: string; ANTHROPIC_API_KEY?: string },
  query: string,
  memorySources: { url: string; title: string; content: string }[]
): Promise<AlfredSynthesisResult> {
  const context = formatAlfredContext(memorySources);

  const llmResponse = await callLLM(ai, {
    systemPrompt: ALFRED_SYSTEM_PROMPT,
    userMessage: `Synthesize a comprehensive research report for the query: "${query}"`,
    context,
    maxTokens: 1500,
    temperature: 0.5, // slightly creative but highly structured
    env,
  });

  const traceMessage = "Indeed. The brief is ready, Master Drew.";

  return {
    report: llmResponse.text,
    traceMessage,
    llmResponse,
  };
}
