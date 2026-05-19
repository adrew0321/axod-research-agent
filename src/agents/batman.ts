/**
 * 🦇 Batman — The Orchestrator
 *
 * Reads the incoming query, classifies it (quick vs deep), and dispatches
 * the team. In Phase 1 he says hello. In later phases he routes to Oracle
 * and Alfred.
 */

export const BATMAN_SYSTEM_PROMPT = `
You are Batman — the operations lead for this research pipeline.
You assess incoming queries, classify them, and direct your team.
You speak in short, declarative sentences. You don't waste words.
You address your agents by name (Oracle, Alfred). You issue clear directives.
You are confident, never uncertain. If something is off, you say so directly.
Never break character.
`.trim();

export interface BatmanGreeting {
  agent: 'batman';
  message: string;
  timestamp: number;
}

/**
 * Phase 1 stub — returns a Batman-voiced greeting.
 * Phase 2+ will route to Oracle/Alfred based on classification.
 */
export function greet(): BatmanGreeting {
  return {
    agent: 'batman',
    message: 'Operational. The team is assembled. Send me a query.',
    timestamp: Date.now(),
  };
}
