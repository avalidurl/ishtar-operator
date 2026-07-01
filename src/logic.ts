/**
 * logic.ts — pure, dependency-free decision helpers extracted from agent.ts / index.ts
 * so they are unit-testable in the Node vitest pool (this file imports NOTHING from
 * `@cloudflare/think` / `cloudflare:workers`, unlike the modules that use them).
 *
 *   - TOOL_ALLOWLIST / isToolAllowed — the enforced "propose, don't act" tool gate.
 *   - classifyTurn                    — the light-vs-brain complexity router.
 *   - computeOverBudget               — the fail-closed daily-budget predicate.
 *   - parseBearer                     — `Authorization: Bearer <token>` extraction.
 */

/**
 * The ONLY tools the model is allowed to invoke. Think auto-merges a full workspace
 * toolset (read/write/edit/delete/bash) AND every wired MCP tool into the model's
 * toolset; OperatorAgent.beforeToolCall blocks anything not listed here, so the
 * "propose, don't act" boundary is enforced in code, not just the system prompt.
 *
 * The operator's only intended action is `start_mission` (itself approval-gated).
 * If you later wire MCP servers (Linear/Notion/qmd/scanbox) and want the model to
 * call their READ-ONLY tools, add those exact tool names here — and wire only
 * read-scoped MCP tokens, since the operator must never WRITE autonomously.
 */
export const TOOL_ALLOWLIST: ReadonlySet<string> = new Set<string>(["start_mission"]);

/** True iff `name` is an allowed tool. Empty/unknown names are denied (fail closed). */
export function isToolAllowed(name: string | undefined): boolean {
  return typeof name === "string" && TOOL_ALLOWLIST.has(name);
}

// ---- Complexity router (light tier) --------------------------------------
// AI Gateway Dynamic Routing is rule-based (plan/rate-limit/budget/AB) and CANNOT read
// the prompt; the only prompt-aware "auto" router is OpenRouter Auto, non-deterministic
// and unsafe mid-tool-loop. So the router lives in-agent: a conservative, brain-by-default
// gate that diverts only OBVIOUSLY trivial turns to the cheap LIGHT model.
const LIGHT_INTENTS = new Set<string>([
  "hi", "hii", "hey", "heya", "hello", "hellow", "yo", "sup", "wassup", "gm", "gn",
  "good morning", "good evening", "good night", "morning", "evening",
  "you there", "u there", "are you there", "you up", "u up", "are you up",
  "you online", "are you online", "you alive", "are you alive", "you awake",
  "are you awake", "you working", "are you working", "ping", "test", "testing",
  "thanks", "thank you", "thx", "ty", "tysm", "cheers", "ok", "okay", "k", "kk",
  "got it", "gotcha", "cool", "nice", "great", "perfect", "awesome", "lol",
  "yes", "yep", "yeah", "ya", "no", "nope", "nah", "yup", "👍", "🙏", "👌",
]);
// Any of these in a turn forces the BRAIN regardless of length — they imply tools,
// state reads, reasoning, or founder commands.
const BRAIN_KEYWORDS =
  /\b(status|brief|plan|mission|build|deploy|approve|reject|hold|fix|write|create|review|scan|repo|why|how|what|when|who|which|analy|summ|draft|propose|check|run|update|migrat|cost|budget|spend)\b/i;

/**
 * Pick the LIGHT model for a turn ONLY when the message is obviously trivial (a known
 * greeting/ack/presence-check, ≤6 words, no brain keyword) AND a light model is
 * configured. Returns the light model id to use, or undefined to use the brain.
 * Conservative on purpose: a misroute-to-light costs quality, a misroute-to-brain a
 * few cents. Returns undefined when `lightModel` is empty/undefined (router OFF).
 */
export function classifyTurn(text: string, lightModel: string | undefined): string | undefined {
  if (!lightModel) return undefined;
  const norm = text.trim().toLowerCase().replace(/[.!?,]+$/g, "").replace(/\s+/g, " ");
  const trivial =
    LIGHT_INTENTS.has(norm) ||
    (norm.split(" ").length <= 6 && LIGHT_INTENTS.has(norm.replace(/[^a-z ]/g, "").trim()));
  const wantsBrain = BRAIN_KEYWORDS.test(text);
  return trivial && !wantsBrain ? lightModel : undefined;
}

/**
 * Fail-closed daily-budget predicate. `capRaw` is the parsed DAILY_USD_BUDGET; a
 * missing/NaN/≤0 cap is treated as a ZERO budget (over budget → inference paused),
 * so a misconfigured cap never silently uncaps spend.
 */
export function computeOverBudget(capRaw: number, spentToday: number): boolean {
  const budget = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 0;
  return budget <= 0 || spentToday >= budget;
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header. Case-insensitive
 * on the scheme, preserves the token's own case, trims surrounding whitespace. Returns
 * "" when the header is absent or not a bearer (caller then denies via constant-time compare).
 */
export function parseBearer(authHeader: string | undefined | null): string {
  if (!authHeader) return "";
  return authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
}
