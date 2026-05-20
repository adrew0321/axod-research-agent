/**
 * AXOD Research Agent — Worker entry
 *
 * Endpoints:
 *   GET  /            → service health
 *   GET  /hello       → Batman greeting + writes a trace to D1
 *   POST /research    → Quick/Deep mode: multi-agent SSE stream
 *   GET  /trace/:id   → retrieve a query + its trace (for "Show Reasoning")
 */

import { TraceStore, hashIp } from './trace';
import { greet, answerQuick } from './agents/batman';
import { runResearch } from './agents/oracle';
import { runSynthesis } from './agents/alfred';
import { tavilySearch } from './tools/tavily';

interface Env {
  DB: D1Database;
  AI: Ai;
  AI_GATEWAY_URL: string;
  ALLOWED_ORIGIN: string;
  ANTHROPIC_API_KEY?: string;
  TAVILY_API_KEY?: string;
  TURNSTILE_SECRET?: string;
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
    const origin = request.headers.get('Origin');
    let allowedOrigin = env.ALLOWED_ORIGIN || '*';
    if (origin) {
      const isAllowed = 
        origin === 'https://axodcreative.pages.dev' ||
        origin === 'https://www.axodcreative.pages.dev' ||
        /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
      if (isAllowed) {
        allowedOrigin = origin;
      }
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const response = await handleRequest(request, env);
    
    // Construct new response with dynamic CORS headers
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', allowedOrigin);
    newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    newHeaders.set('Access-Control-Allow-Headers', 'Content-Type');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // ── GET / → service health ─────────────────────────────────────
  if (url.pathname === '/') {
    return json(
      {
        service: 'axod-research-agent',
        version: '1.0.0',
        status: 'operational',
        agents: ['batman', 'oracle', 'alfred'],
        phase: 3,
        modes: ['quick', 'deep'],
        turnstileConfigured: !!env.TURNSTILE_SECRET,
      },
      env
    );
  }

  // ── GET /hello → Batman greeting + trace ───────────────────────
  if (url.pathname === '/hello' && request.method === 'GET') {
    return handleHello(request, env);
  }

  // ── POST /research → Quick / Deep mode SSE stream ───────────────
  if (url.pathname === '/research' && request.method === 'POST') {
    return handleResearchStream(request, env);
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
}

/** GET /hello — health check */
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

/** Check rate limits using D1 (max 10 queries per IP per day) */
async function checkRateLimit(db: D1Database, ipHash: string): Promise<boolean> {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM queries WHERE ip_hash=? AND created_at > ?')
    .bind(ipHash, oneDayAgo)
    .first<{ count: number }>();
  return (result?.count ?? 0) < 10;
}

/** Verify Cloudflare Turnstile token */
async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);
  formData.append('remoteip', ip);

  const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  const res = await fetch(url, {
    body: formData,
    method: 'POST',
  });

  const outcome = (await res.json()) as { success: boolean };
  return outcome.success;
}

/**
 * POST /research
 * Body: { "query": "...", "mode": "quick | deep", "cf-turnstile-response": "..." }
 *
 * Unified SSE Stream pipeline returning real-time progress events
 * and the final generated report.
 */
async function handleResearchStream(request: Request, env: Env): Promise<Response> {
  // 1. Parse JSON
  let body: { query?: string; mode?: string; 'cf-turnstile-response'?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'invalid_json' }, env, 400);
  }

  const query = (body.query ?? '').trim();
  const mode = body.mode === 'deep' ? 'deep' : 'quick';
  const turnstileToken = body['cf-turnstile-response'] || '';

  // 2. Validate
  if (!query) {
    return json({ error: 'query_required' }, env, 400);
  }
  if (query.length > 500) {
    return json({ error: 'query_too_long', max: 500 }, env, 400);
  }
  if (!env.TAVILY_API_KEY) {
    return json({ error: 'tavily_key_not_configured' }, env, 500);
  }

  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    '127.0.0.1';
  const ipHash = await hashIp(ip);

  // 3. Turnstile validation (Phase 4) - only run if secret key is present
  if (env.TURNSTILE_SECRET) {
    if (!turnstileToken) {
      return json({ error: 'turnstile_verification_required' }, env, 403);
    }
    const success = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, ip);
    if (!success) {
      return json({ error: 'turnstile_verification_failed' }, env, 403);
    }
  }

  // 4. Rate limiting (Phase 4)
  const isAllowed = await checkRateLimit(env.DB, ipHash);
  if (!isAllowed) {
    return json({ error: 'rate_limit_exceeded', limit: 10 }, env, 429);
  }

  // 5. SSE Streaming Setup
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = (event: string, data: unknown) => {
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Run the multi-agent orchestration async so we can return the SSE response immediately
  (async () => {
    const trace = new TraceStore(env.DB);
    const queryId = crypto.randomUUID();
    const startedAt = Date.now();
    let sequence = 0;

    try {
      // ── Create query record ──────────────────────────────────────
      await trace.createQuery({
        id: queryId,
        ipHash,
        mode,
        queryText: query,
      });

      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let totalCostUsd = 0;
      let searchResults: any[] = [];

      // ── STEP 1: Batman Assesses & Classifies ─────────────────────
      sequence++;
      const batmanAssessStart = Date.now();
      const batmanDialogue = mode === 'deep'
        ? "Deep research. Oracle — engage the network."
        : "Quick research. Scanning networks and writing a direct brief.";

      sendEvent('agent_state', {
        queryId,
        sequence,
        agent: 'batman',
        status: 'handoff',
        message: batmanDialogue,
      });

      await trace.recordEvent({
        queryId,
        sequence,
        agentName: 'batman',
        actionType: 'handoff',
        input: { query, mode },
        output: { dialogue: batmanDialogue },
        durationMs: Date.now() - batmanAssessStart,
      });

      // ── STEP 2: Oracle Sweeps & Memory Write ─────────────────────
      sequence++;
      const oracleSearchStart = Date.now();
      sendEvent('agent_state', {
        queryId,
        sequence,
        agent: 'oracle',
        status: 'searching',
        message: 'Oracle is scanning the global network grids...',
      });

      if (mode === 'deep') {
        const oracleResult = await runResearch(trace, queryId, query, env.TAVILY_API_KEY!);
        searchResults = oracleResult.results;

        sendEvent('agent_state', {
          queryId,
          sequence,
          agent: 'oracle',
          status: 'completed',
          message: oracleResult.message,
        });

        await trace.recordEvent({
          queryId,
          sequence,
          agentName: 'oracle',
          actionType: 'tool_call',
          input: { tool: 'tavily_search', query, depth: 'advanced' },
          output: { dialogue: oracleResult.message, sourcesFound: oracleResult.sourcesFound },
          durationMs: Date.now() - oracleSearchStart,
        });
      } else {
        // Quick mode Tavily basic search
        const tavilyResponse = await tavilySearch(query, env.TAVILY_API_KEY!, {
          searchDepth: 'basic',
          maxResults: 4,
        });
        searchResults = tavilyResponse.results;
        const msg = `Swept ${searchResults.length} sources quickly. Sending intelligence up.`;

        sendEvent('agent_state', {
          queryId,
          sequence,
          agent: 'oracle',
          status: 'completed',
          message: msg,
        });

        await trace.recordEvent({
          queryId,
          sequence,
          agentName: 'oracle',
          actionType: 'tool_call',
          input: { tool: 'tavily_search', query, depth: 'basic' },
          output: { dialogue: msg, sourcesFound: searchResults.length },
          durationMs: tavilyResponse.responseTime,
        });
      }

      // ── STEP 3: Synthesis ────────────────────────────────────────
      let finalReportText = '';

      if (mode === 'deep') {
        // ── 3a. Batman Handoff to Alfred ───────────────────────────
        sequence++;
        const batmanAlfredHandoffStart = Date.now();
        const handoffDialogue = "Alfred, your turn. Make it sharp.";

        sendEvent('agent_state', {
          queryId,
          sequence,
          agent: 'batman',
          status: 'handoff',
          message: handoffDialogue,
        });

        await trace.recordEvent({
          queryId,
          sequence,
          agentName: 'batman',
          actionType: 'handoff',
          input: { targetAgent: 'alfred' },
          output: { dialogue: handoffDialogue },
          durationMs: Date.now() - batmanAlfredHandoffStart,
        });

        // ── 3b. Alfred Synthesis ───────────────────────────────────
        sequence++;
        const alfredSynthStart = Date.now();
        sendEvent('agent_state', {
          queryId,
          sequence,
          agent: 'alfred',
          status: 'synthesizing',
          message: 'Alfred is compiling the structured dossier...',
        });

        const memorySources = await trace.getResearchMemory(queryId);
        const alfredResult = await runSynthesis(env.AI, env, query, memorySources);

        finalReportText = alfredResult.report;
        totalTokensIn += alfredResult.llmResponse.tokensIn;
        totalTokensOut += alfredResult.llmResponse.tokensOut;
        totalCostUsd += alfredResult.llmResponse.costUsd;

        sendEvent('agent_state', {
          queryId,
          sequence,
          agent: 'alfred',
          status: 'completed',
          message: alfredResult.traceMessage,
        });

        await trace.recordEvent({
          queryId,
          sequence,
          agentName: 'alfred',
          actionType: 'llm_call',
          input: { model: alfredResult.llmResponse.model, sourcesUsed: memorySources.length },
          output: { dialogue: alfredResult.traceMessage, length: finalReportText.length },
          durationMs: Date.now() - alfredSynthStart,
          tokensIn: alfredResult.llmResponse.tokensIn,
          tokensOut: alfredResult.llmResponse.tokensOut,
          costUsd: alfredResult.llmResponse.costUsd,
        });
      } else {
        // Quick mode Batman LLM call
        sequence++;
        const batmanQuickStart = Date.now();
        sendEvent('agent_state', {
          queryId,
          sequence,
          agent: 'batman',
          status: 'synthesizing',
          message: 'Batman is drawing direct conclusions from intel...',
        });

        const llmResponse = await answerQuick(env.AI, query, searchResults, env);
        finalReportText = llmResponse.text;
        totalTokensIn += llmResponse.tokensIn;
        totalTokensOut += llmResponse.tokensOut;
        totalCostUsd += llmResponse.costUsd;

        sendEvent('agent_state', {
          queryId,
          sequence,
          agent: 'batman',
          status: 'completed',
          message: "Report finished. Transmitting brief.",
        });

        await trace.recordEvent({
          queryId,
          sequence,
          agentName: 'batman',
          actionType: 'llm_call',
          input: { model: llmResponse.model, sourcesUsed: searchResults.length },
          output: { dialogue: "Operational. Transmission complete.", length: finalReportText.length },
          durationMs: Date.now() - batmanQuickStart,
          tokensIn: llmResponse.tokensIn,
          tokensOut: llmResponse.tokensOut,
          costUsd: llmResponse.costUsd,
        });
      }

      // ── STEP 4: Query Completion ─────────────────────────────────
      const totalDurationMs = Date.now() - startedAt;
      await trace.completeQuery(queryId, {
        report: finalReportText,
        totalDurationMs,
        totalTokensIn,
        totalTokensOut,
        totalCostUsd,
      });

      sendEvent('report_complete', {
        queryId,
        mode,
        report: finalReportText,
        sources: searchResults.map((r, i) => ({
          n: i + 1,
          title: r.title,
          url: r.url,
        })),
        stats: {
          totalDurationMs,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          costUsd: totalCostUsd,
          sourcesFound: searchResults.length,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await trace.failQuery(queryId, msg).catch(() => {});
      sendEvent('error', { queryId, detail: msg });
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders(env),
    },
  });
}
