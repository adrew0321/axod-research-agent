/**
 * Trace module — writes structured agent activity to Cloudflare D1.
 * Every query creates one `queries` row; every agent step appends a `trace_events` row.
 */

export type Mode = 'quick' | 'deep';
export type AgentName = 'batman' | 'oracle' | 'alfred';
export type ActionType = 'llm_call' | 'tool_call' | 'decision' | 'handoff';

export interface CreateQueryInput {
  id: string;
  ipHash: string;
  mode: Mode;
  queryText: string;
}

export interface TraceEventInput {
  queryId: string;
  sequence: number;
  agentName: AgentName;
  actionType: ActionType;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export class TraceStore {
  constructor(private db: D1Database) {}

  /** Insert a new query row with status='pending'. */
  async createQuery(input: CreateQueryInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO queries (id, created_at, ip_hash, mode, query_text, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      )
      .bind(input.id, Date.now(), input.ipHash, input.mode, input.queryText)
      .run();
  }

  /** Append one trace event for an agent action. */
  async recordEvent(event: TraceEventInput): Promise<void> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO trace_events
         (id, query_id, sequence, timestamp, agent_name, action_type,
          input, output, duration_ms, tokens_in, tokens_out, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        event.queryId,
        event.sequence,
        Date.now(),
        event.agentName,
        event.actionType,
        event.input ? JSON.stringify(event.input) : null,
        event.output ? JSON.stringify(event.output) : null,
        event.durationMs ?? null,
        event.tokensIn ?? null,
        event.tokensOut ?? null,
        event.costUsd ?? null
      )
      .run();
  }

  /** Mark a query as complete with final aggregates. */
  async completeQuery(
    id: string,
    final: {
      report: string;
      totalDurationMs: number;
      totalTokensIn: number;
      totalTokensOut: number;
      totalCostUsd: number;
    }
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE queries
         SET status='complete',
             final_report=?,
             total_duration_ms=?,
             total_tokens_in=?,
             total_tokens_out=?,
             total_cost_usd=?
         WHERE id=?`
      )
      .bind(
        final.report,
        final.totalDurationMs,
        final.totalTokensIn,
        final.totalTokensOut,
        final.totalCostUsd,
        id
      )
      .run();
  }

  /** Mark a query as failed. */
  async failQuery(id: string, errorMessage: string): Promise<void> {
    await this.db
      .prepare(`UPDATE queries SET status='error', error_message=? WHERE id=?`)
      .bind(errorMessage, id)
      .run();
  }

  /** Fetch a query + its trace events for the "Show Reasoning" UI. */
  async getQueryWithTrace(id: string): Promise<{
    query: Record<string, unknown> | null;
    events: Record<string, unknown>[];
  }> {
    const query = await this.db
      .prepare(`SELECT * FROM queries WHERE id=?`)
      .bind(id)
      .first();
    const events = await this.db
      .prepare(`SELECT * FROM trace_events WHERE query_id=? ORDER BY sequence ASC`)
      .bind(id)
      .all();
    return { query, events: events.results };
  }

  /** Store raw or chunked research memory into D1. */
  async storeResearchMemory(
    queryId: string,
    chunks: { url: string; title: string; content: string }[]
  ): Promise<void> {
    const statements = chunks.map(chunk =>
      this.db
        .prepare(
          `INSERT INTO research_memory (id, query_id, url, title, content)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(crypto.randomUUID(), queryId, chunk.url, chunk.title, chunk.content)
    );
    await this.db.batch(statements);
  }

  /** Retrieve research memory for Alfred to synthesize. */
  async getResearchMemory(
    queryId: string
  ): Promise<{ url: string; title: string; content: string }[]> {
    const { results } = await this.db
      .prepare(`SELECT url, title, content FROM research_memory WHERE query_id=?`)
      .bind(queryId)
      .all<{ url: string; title: string; content: string }>();
    return results;
  }
}

/** SHA-256 hash an IP address for privacy-preserving logging. */
export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
