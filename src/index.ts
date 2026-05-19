/**
 * AXOD Research Agent — Worker entry
 *
 * Phase 1 endpoints:
 *   GET  /           → service health
 *   GET  /hello      → Batman says hello + writes a trace to D1
 *   GET  /trace/:id  → retrieve a query + its trace (for "Show Reasoning")
 */

import { TraceStore, hashIp } from './trace';
import { greet } from './agents/batman';

interface Env {
  DB: D1Database;
  AI_GATEWAY_URL: string;
  ALLOWED_ORIGIN: string;
  ANTHROPIC_API_KEY?: string;
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
          version: '0.1.0',
          status: 'operational',
          agents: ['batman', 'oracle', 'alfred'],
          phase: 1,
        },
        env
      );
    }

    // ── GET /hello → Batman speaks + trace written to D1 ───────────
    if (url.pathname === '/hello' && request.method === 'GET') {
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

      return json(
        {
          queryId,
          ...greeting,
        },
        env
      );
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
