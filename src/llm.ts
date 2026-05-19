/**
 * LLM Client
 *
 * Wraps the model provider behind a stable interface so the rest of
 * the codebase doesn't care whether we're using Workers AI or Anthropic.
 *
 * Phase 2: routes to Cloudflare Workers AI (Llama 3.3 70B, free tier).
 * Future: swap implementation to call Anthropic via AI Gateway once the
 * key is configured. The interface stays the same.
 */

/** Default model — Llama 3.3 70B FP8-fast, Cloudflare's flagship free-tier model */
export const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCallOptions {
  systemPrompt: string;
  userMessage: string;
  /** Optional context to prepend to user message (e.g. search results) */
  context?: string;
  /** Max tokens to generate. Default: 1024. */
  maxTokens?: number;
  /** Temperature 0-2. Default: 0.6 (balanced). */
  temperature?: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  /** Approximate tokens — Workers AI doesn't always return exact counts */
  tokensIn: number;
  tokensOut: number;
  /** Cost in USD. $0 for Workers AI free tier. */
  costUsd: number;
  durationMs: number;
}

/**
 * Call the LLM and return its completion.
 * Throws if the model call fails.
 */
export async function callLLM(
  ai: Ai,
  options: LLMCallOptions
): Promise<LLMResponse> {
  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    {
      role: 'user',
      content: options.context
        ? `${options.context}\n\n---\n\n${options.userMessage}`
        : options.userMessage,
    },
  ];

  const startedAt = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await ai.run(DEFAULT_MODEL as keyof AiModels, {
    messages,
    max_tokens: options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0.6,
  });
  const durationMs = Date.now() - startedAt;

  const text: string = result?.response ?? '';

  // Rough token approximation: 1 token ~= 4 chars. Workers AI doesn't expose token counts reliably.
  const tokensIn = Math.ceil(
    messages.map(m => m.content).join('').length / 4
  );
  const tokensOut = Math.ceil(text.length / 4);

  return {
    text,
    model: DEFAULT_MODEL,
    tokensIn,
    tokensOut,
    costUsd: 0, // Workers AI free tier
    durationMs,
  };
}
