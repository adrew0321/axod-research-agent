/**
 * AXOD Research Agent — Worker entry
 *
 * Endpoints:
 *   GET  /            → service health
 *   GET  /hello       → Batman greeting + writes a trace to D1
 *   POST /research    → Quick mode: search + LLM answer + full trace
 *   GET  /trace/:id   → retrieve a query + its trace (for "Show Reasoning")
 */

import { TraceStore, hashIp } from './trace';
import { greet, answerQuick } from './agents/batman';
import { tavilySearch } from './tools/tavily';

interface Env {
  DB: D1Database;
  AI: Ai;
  AI_GATEWAY_URL: string;
  ALLOWED_ORIGIN: string;
  ANTHROPIC_API_KEY?: string;
  TAVILY_API_KEY?: string;
}

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body: unknown, env: Env, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // ── GET / → service health ─────────────────────────────────────
    if (url.pathname === '/') {
      return json(
        {
          service: 'axod-research-agent',
          version: '0.2.0',
          status: 'operational',
          agents: ['batman', 'oracle', 'alfred'],
          phase: 2,
          modes: ['quick'],
        },
        env
      );
    }

    // ── GET /hello → Batman greeting + trace ───────────────────────
    if (url.pathname === '/hello' && request.method === 'GET') {
      return handleHello(request, env);
    }

    // ── POST /research → Quick mode (Phase 2) ──────────────────────
    if (url.pathname === '/research' && request.method === 'POST') {
      return handleResearch(request, env);
    }

    // ── GET /trace/:id → fetch a query + its trace events ──────────
    const traceMatch = url.pathname.match(/^\/trace\/([a-f0-9-]+)$/);
    if (traceMatch && request.method === 'GET') {
      const trace = new TraceStore(env.DB);
      const result = await trace.getQueryWithTrace(traceMatch[1]);
      if (!result.query) {
        return json({ error: 'not_found' }, env, 404);
      }
      return json(result, env);
    }

    return json({ error: 'not_found', path: url.pathname }, env, 404);
  },
};

/** GET /hello — unchanged from Phase 1 */
async function handleHello(request: Request, env: Env): Promise<Response> {
  const trace = new TraceStore(env.DB);
  const queryId = crypto.randomUUID();
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown';
  const ipHash = await hashIp(ip);

  const t0 = Date.now();
  const greeting = greet();
  const durationMs = Date.now() - t0;

  try {
    await trace.createQuery({
      id: queryId,
      ipHash,
      mode: 'quick',
      queryText: '__phase1_hello__',
    });
    await trace.recordEvent({
      queryId,
      sequence: 1,
      agentName: 'batman',
      actionType: 'decision',
      input: { endpoint: '/hello' },
      output: greeting,
      durationMs,
    });
    await trace.completeQuery(queryId, {
      report: greeting.message,
      totalDurationMs: durationMs,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCostUsd: 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: 'trace_failed', detail: msg, greeting }, env, 500);
  }

  return json({ queryId, ...greeting }, env);
}

/**
 * POST /research
 * Body: { "query": "your question", "mode": "quick" }
 *
 * Pipeline:
 *   1. Validate input
 *   2. Create query record in D1
 *   3. Oracle: Tavily search → trace tool_call
 *   4. Batman: LLM call with search context → trace llm_call
 *   5. Mark query complete + return JSON
 */
async function handleResearch(request: Request, env: Env): Promise<Response> {
  // ── 1. Validate ───────────────────────────────────────────────
  let body: { query?: string; mode?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'invalid_json' }, env, 400);
  }

  const query = (body.query ?? '').trim();
  const mode = body.mode === 'deep' ? 'deep' : 'quick';

  if (!query) {
    return json({ error: 'query_required' }, env, 400);
  }
  if (query.length > 500) {
    return json({ error: 'query_too_long', max: 500 }, env, 400);
  }
  if (mode === 'deep') {
    return json({ error: 'deep_mode_not_yet_supported', phase: 2 }, env, 501);
  }
  if (!env.TAVILY_API_KEY) {
    return json({ error: 'tavily_key_not_configured' }, env, 500);
  }

  // ── 2. Create query record ────────────────────────────────────
  const trace = new TraceStore(env.DB);
  const queryId = crypto.randomUUID();
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown';
  const ipHash = await hashIp(ip);
  const startedAt = Date.now();

  await trace.createQuery({
    id: queryId,
    ipHash,
    mode: 'quick',
    queryText: query,
  });

  let sequence = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;

  try {
    // ── 3. Oracle: web search ───────────────────────────────────
    sequence++;
    const searchResponse = await tavilySearch(query, env.TAVILY_API_KEY, {
      searchDepth: 'basic',
      maxResults: 5,
    });

    await trace.recordEvent({
      queryId,
      sequence,
      agentName: 'oracle',
      actionType: 'tool_call',
      input: { tool: 'tavily_search', query, depth: 'basic' },
      output: {
        sourcesFound: searchResponse.results.length,
        topUrls: searchResponse.results.slice(0, 3).map(r => r.url),
      },
      durationMs: searchResponse.responseTime,
    });

    // ── 4. Batman: LLM answer ───────────────────────────────────
    sequence++;
    const llmResponse = await answerQuick(env.AI, query, searchResponse.results);

    await trace.recordEvent({
      queryId,
      sequence,
      agentName: 'batman',
      actionType: 'llm_call',
      input: {
        model: llmResponse.model,
        query,
        sourcesUsed: searchResponse.results.length,
      },
      output: { textPreview: llmResponse.text.slice(0, 400) },
      durationMs: llmResponse.durationMs,
      tokensIn: llmResponse.tokensIn,
      tokensOut: llmResponse.tokensOut,
      costUsd: llmResponse.costUsd,
    });

    totalTokensIn += llmResponse.tokensIn;
    totalTokensOut += llmResponse.tokensOut;
    totalCostUsd += llmResponse.costUsd;

    // ── 5. Complete + return ────────────────────────────────────
    const totalDurationMs = Date.now() - startedAt;
    await trace.completeQuery(queryId, {
      report: llmResponse.text,
      totalDurationMs,
      totalTokensIn,
      totalTokensOut,
      totalCostUsd,
    });

    return json(
      {
        queryId,
        mode: 'quick',
        report: llmResponse.text,
        sources: searchResponse.results.map((r, i) => ({
          n: i + 1,
          title: r.title,
          url: r.url,
        })),
        stats: {
          totalDurationMs,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          costUsd: totalCostUsd,
          sourcesFound: searchResponse.results.length,
        },
      },
      env
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await trace.failQuery(queryId, msg).catch(() => {});
    return json({ error: 'research_failed', detail: msg, queryId }, env, 500);
  }
}
