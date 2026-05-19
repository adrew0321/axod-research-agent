-- AXOD Research Agent — D1 Schema
-- Stores one row per query, many rows per agent action.

CREATE TABLE IF NOT EXISTS queries (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('quick', 'deep')),
  query_text TEXT NOT NULL,
  final_report TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'error')),
  total_duration_ms INTEGER,
  total_tokens_in INTEGER,
  total_tokens_out INTEGER,
  total_cost_usd REAL,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS trace_events (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('llm_call', 'tool_call', 'decision', 'handoff')),
  input TEXT,
  output TEXT,
  duration_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  FOREIGN KEY (query_id) REFERENCES queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trace_query ON trace_events(query_id, sequence);
CREATE INDEX IF NOT EXISTS idx_queries_created ON queries(created_at);
CREATE INDEX IF NOT EXISTS idx_queries_status ON queries(status);

CREATE TABLE IF NOT EXISTS research_memory (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  FOREIGN KEY (query_id) REFERENCES queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_query ON research_memory(query_id);
