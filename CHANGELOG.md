# Changelog

All notable changes to `axod-research-agent`. Semantic Versioning.

---

## [0.2.0] — 2026-05-19

### Added — Phase 2: Quick mode

- `POST /research` endpoint with `mode: "quick"` — accepts a query, runs a Tavily web search, calls the LLM with results as context, returns a structured answer with cited sources
- Workers AI binding (`env.AI`, Llama 3.3 70B FP8-fast) — free-tier LLM for Phase 2; swap to Claude via AI Gateway later when Anthropic key is configured
- `src/tools/tavily.ts` — Tavily search client with basic/advanced depth modes
- `src/llm.ts` — provider-agnostic LLM client wrapping Workers AI; future Anthropic swap is a one-file change
- Batman's `answerQuick()` — produces concise, source-cited answers with a "Bottom line:" close
- Full agent tracing per query — every `tool_call` and `llm_call` recorded to D1 with input, output, duration, and token usage
- `AGENTS.md` — single source of truth for agent personalities, system prompts, and sample voices
- `.dev.vars` for local secret loading (gitignored)

### Verified
End-to-end test with query "What is Cloudflare Workers AI and what models does it support?":
- 3.8 second total duration
- 5 Tavily sources retrieved (214ms)
- Llama 3.3 70B answered in 3.4s with inline citations
- $0 cost (Workers AI free tier)
- 2 trace events written and retrievable via `/trace/:id`

---

## [0.1.0] — 2026-05-18

### Added — Phase 1: Scaffold

- Cloudflare Workers project structure with TypeScript + Wrangler 4.92
- D1 database `axod-research-traces` with `queries` + `trace_events` tables
- `src/trace.ts` — TraceStore class + IP hashing for privacy
- `src/agents/batman.ts` — Batman's voice + greeting
- `GET /` health endpoint, `GET /hello` Batman greeting, `GET /trace/:id` retrieval
- AI Gateway URL configured (`gateway.ai.cloudflare.com/.../axod-research/anthropic`) for future Claude calls
- GitHub repo at [adrew0321/axod-research-agent](https://github.com/adrew0321/axod-research-agent) with `main` and `dev` branches
