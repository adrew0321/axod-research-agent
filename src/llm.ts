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
  /** Approximate or actual tokens */
  tokensIn: number;
  tokensOut: number;
  /** Cost in USD */
  costUsd: number;
  durationMs: number;
}

/**
 * Call the LLM and return its completion.
 * Routes to Anthropic Claude via AI Gateway if ANTHROPIC_API_KEY is configured,
 * otherwise falls back to free-tier Workers AI Llama.
 */
export async function callLLM(
  ai: Ai,
  options: LLMCallOptions & { env?: { AI_GATEWAY_URL?: string; ANTHROPIC_API_KEY?: string } }
): Promise<LLMResponse> {
  const startedAt = Date.now();
  const apiKey = options.env?.ANTHROPIC_API_KEY;
  const userContent = options.context
    ? `${options.context}\n\n---\n\n${options.userMessage}`
    : options.userMessage;

  // ── Route A: Anthropic via AI Gateway ───────────────────────────
  if (apiKey) {
    const gatewayUrl =
      options.env?.AI_GATEWAY_URL ||
      'https://gateway.ai.cloudflare.com/v1/243a3def5fcf5f0db8918ee9f75daebd/axod-research/anthropic';
    const url = gatewayUrl.endsWith('/messages') ? gatewayUrl : `${gatewayUrl}/messages`;

    const modelName = 'claude-3-5-sonnet-20241022';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: options.maxTokens ?? 1024,
        system: options.systemPrompt,
        messages: [{ role: 'user', content: userContent }],
        temperature: options.temperature ?? 0.6,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic Gateway call failed (${res.status}): ${errText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    const text = data.content?.[0]?.text ?? '';
    const tokensIn = data.usage?.input_tokens ?? 0;
    const tokensOut = data.usage?.output_tokens ?? 0;

    // Claude 3.5 Sonnet: $3 / M input, $15 / M output
    const costUsd = (tokensIn * 3 + tokensOut * 15) / 1000000;
    const durationMs = Date.now() - startedAt;

    return {
      text,
      model: modelName,
      tokensIn,
      tokensOut,
      costUsd,
      durationMs,
    };
  }

  // ── Route B: Workers AI Fallback ────────────────────────────────
  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: userContent },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await ai.run(DEFAULT_MODEL as keyof AiModels, {
    messages,
    max_tokens: options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0.6,
  });
  const durationMs = Date.now() - startedAt;

  const text: string = result?.response ?? '';

  // Rough token approximation: 1 token ~= 4 chars.
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
