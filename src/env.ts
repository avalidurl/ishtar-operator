/**
 * env.ts — the Operator brain's binding & variable surface.
 *
 * Ishtar-the-Agent is the founder-facing OPERATOR (not the matcher — the venue
 * Worker's MatchCoordinator DO owns matching). It runs as a Cloudflare Agent
 * (a Durable Object) on the Agents SDK. Every model call routes through the
 * `datebook` AI Gateway (dollar cap + logs in the dashboard). No OpenAI.
 *
 * SECURITY: the treasury/signing key NEVER lives here. The operator can read,
 * plan, brief, and PROPOSE actions; deploy / money / identity-reveal / external
 * posting are founder-gated behind a Workflow approval (see missions.ts).
 */
import type { AgentNamespace } from "agents";
import type { OperatorAgent } from "./agent";

/** Minimal Worker Loader binding shape (avoids depending on a workers-types version
 *  that may predate the global WorkerLoader type). Matches the Dynamic Workers API. */
export interface WorkerLoaderLike {
  get(
    id: string,
    factory: () => Promise<{
      compatibilityDate: string;
      compatibilityFlags?: string[];
      mainModule: string;
      modules: Record<string, string>;
      env?: Record<string, unknown>;
      globalOutbound?: unknown;
    }>,
  ): { getEntrypoint(name?: string): { fetch(req: Request): Promise<Response> } & Record<string, unknown> };
}

export interface Env {
  /** Self Durable-Object namespace (the OperatorAgent). Used by routeAgentRequest / getAgentByName. */
  OperatorAgent: AgentNamespace<OperatorAgent>;

  /** Workers AI binding — the ONLY inference surface. Routed via AI_GATEWAY_ID. */
  AI: Ai;

  /** GA Cloudflare Workflows binding for the build-orchestrator missions (approval-gated). */
  MISSION_WORKFLOW: Workflow;

  /** Dynamic Workflows (LIVE when DYNAMIC_MISSIONS="true"): the runtime-generated-mission engine.
   *  Needs the Worker Loader open-beta entitlement on the account to deploy (DEPLOY.md). */
  LOADER: WorkerLoaderLike;
  DYNAMIC_WORKFLOWS: Workflow;

  /** SECRET — founder bearer gate for POST /admin/* routes. Never logged/echoed. */
  ACCESS_KEY: string;
  /** SECRET — Slack app signing secret; verifies POST /slack authenticity. Never log. */
  SLACK_SIGNING_SECRET: string;
  /** SECRET — Slack bot OAuth token (xoxb-…) for chat.postMessage. Never log. */
  SLACK_BOT_TOKEN: string;

  /** Optional — lock Slack to one workspace (team_id "T…"). Empty = any. */
  SLACK_TEAM_ID?: string;
  /** Optional — lock Slack to the founder's member id ("U…"). Empty = any in team. */
  SLACK_FOUNDER_USER_ID?: string;
  /** Optional — the channel the daily brief is posted to ("C…"). */
  SLACK_BRIEF_CHANNEL?: string;

  /** Workers-AI model id for operator reasoning. */
  CHAT_MODEL: string;
  /** AI Gateway id; all env.AI.run calls route through it (dollar cap in dashboard). */
  AI_GATEWAY_ID: string;
  /** Hard daily AI spend ceiling in USD (string float, parsed at use site). */
  DAILY_USD_BUDGET: string;

  /** Optional MCP tool endpoints — wired in onStart() when present (founder-provided). */
  MCP_LINEAR_URL?: string;
  MCP_NOTION_URL?: string;
  MCP_QMD_URL?: string;
  MCP_SCANBOX_URL?: string;
  /** SECRET — bearer attached to authed MCP servers (e.g. CF-Access-gated). Never log. */
  MCP_TOKEN?: string;

  /**
   * Founder flag — "true" enables the Dynamic Workflows mission path (agent-generated
   * mission code at runtime). OFF by default. Requires the Worker Loader open-beta
   * entitlement + agent-generated-code sandboxing review. See mission-dynamic.ts + DEPLOY.md.
   */
  DYNAMIC_MISSIONS?: string;
}
