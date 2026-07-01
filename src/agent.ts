/**
 * agent.ts — OperatorAgent: Ishtar-the-Agent as a Project Think agent on the
 * Cloudflare Agents SDK (an Agent IS a Durable Object).
 *
 * Think (@cloudflare/think) owns the agentic loop, memory (Session), streaming,
 * and tools; we provide getModel()/getSystemPrompt()/getTools() and the lifecycle
 * hooks. Think extends Agent, so this.schedule / this.sql / this.runWorkflow /
 * this.addMcpServer are all still available.
 *
 * The founder-facing OPERATOR. It does NOT run matching (the venue Worker's
 * MatchCoordinator DO owns that). Roles (playbooks in ./skills, embedded below as
 * always-on behavior per CF guidance): operator chat · daily brief · build-mission
 * orchestrator (GA Workflow + Dynamic Workflow) · chaperone oversight · evaluator.
 *
 * INVARIANTS: every model call routes through the `datebook` AI Gateway (getModel
 * gateway config) · daily USD budget hard-stop, fail-closed · the operator PROPOSES,
 * deploy/money/reveal/external-post are founder-gated behind a Workflow approval, and
 * that boundary is ENFORCED in code by beforeToolCall + workspaceBash=false (not just
 * the prompt) · no treasury key in this runtime · secrets never echoed (scrubSecrets).
 */
import { Think } from "@cloudflare/think";
import type { ToolCallContext, ToolCallDecision } from "@cloudflare/think";
import { tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { Env } from "./env";
import { classifyTurn, computeOverBudget, isToolAllowed, TOOL_ALLOWLIST } from "./logic";
import { triggerDynamicMission } from "./mission-dynamic";

const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** Emit a single-line structured JSON log. Never throws (logging must not break a turn). */
function logError(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.error(JSON.stringify({ level: "error", event, ...fields }));
  } catch {
    /* logging is best-effort */
  }
}

// Per-M-token USD prices, read from the live Workers-AI catalog (models/search
// → properties.price) — not guessed. Keep both router tiers here so onStepFinish
// charges the budget at the model that actually ran.
const PRICING: Record<string, { in: number; out: number }> = {
  "@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 }, // operator BRAIN (fast ~0.5s)
  "@cf/openai/gpt-oss-20b": { in: 0.2, out: 0.3 }, // LIGHT tier (~0.7s)
  "@cf/nvidia/nemotron-3-120b-a12b": { in: 0.0, out: 0.0 }, // alt brain (price n/a in catalog)
  "@cf/moonshotai/kimi-k2.6": { in: 0.95, out: 4.0 },
  "@cf/zai-org/glm-4.7-flash": { in: 0.0605, out: 0.4 },
  "@cf/zai-org/glm-5.2": { in: 1.4, out: 4.4 }, // benched: 45-55s/call
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
};
const DEFAULT_PRICE = { in: 0.3, out: 2.5 };

/** One mission spec the orchestrator hands to a Workflow. */
export interface MissionParams {
  title: string;
  goal: string;
  repo?: string;
  requestedBy: string;
}

export class OperatorAgent extends Think<Env> {
  /**
   * SECURITY — enforce "propose, don't act" in CODE, not just the prompt. Think enables
   * a workspace shell tool by default and merges the full workspace toolset
   * (read/write/edit/delete/bash) plus every wired MCP tool into the toolset handed to
   * the model. Without this, the system-prompt boundary is jailbreakable (a prompt
   * injection via untrusted MCP output or a crafted message could mutate DO state / call
   * MCP write tools). We disable the shell entirely and block any tool not on the
   * allowlist (see ./logic TOOL_ALLOWLIST — currently just `start_mission`).
   */
  override workspaceBash = false;

  override beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    if (!isToolAllowed(ctx.toolName)) {
      return {
        action: "block",
        reason: `Tool "${ctx.toolName}" is not permitted — the operator proposes, it does not act. Allowed: ${[...TOOL_ALLOWLIST].join(", ")}. Queue a build mission with start_mission instead.`,
      };
    }
  }

  /** Model id the router picked for the CURRENT turn. getModel reads it; routeTurn
   *  sets it at turn start, then it sticks for the whole turn (never swap mid-loop —
   *  that breaks tool-call formatting). Defaults to the brain when unset. */
  private routedModel?: string;

  /** The id of the model that should run right now (routed light tier or brain). */
  private activeModel(): string {
    return this.routedModel ?? this.env.CHAT_MODEL;
  }

  /** Route this turn to the light tier vs the brain (see ./logic classifyTurn). Once per turn. */
  private routeTurn(text: string): void {
    this.routedModel = classifyTurn(text, this.env.LIGHT_MODEL);
  }

  /** The model — Workers AI routed through the `datebook` AI Gateway (cap + logs).
   *  Model id = the router's pick for this turn (light tier or brain). */
  getModel() {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: { id: this.env.AI_GATEWAY_ID },
    });
    // FAST MODE. GLM-5.2 / Kimi / GPT-OSS deliberate ("thinking") by default →
    // ~60s/reply, unusable for interactive Slack. reasoning_effort:"low" +
    // enable_thinking:false is the Workers-AI fast/no-deliberation switch (a few
    // seconds). Unsupported keys are ignored by models that don't have thinking.
    return workersai(this.activeModel(), {
      reasoning_effort: "low",
      chat_template_kwargs: { enable_thinking: false },
    } as Record<string, unknown>);
  }

  /** Always-on operator behavior (the operator-grammar + chaperone-decision playbooks). */
  getSystemPrompt(): string {
    return OPERATOR_SYSTEM;
  }

  /** Tools the operator may call. `start_mission` queues an approval-gated build mission.
   *  NOTE: this is the ONLY tool the model may actually invoke — beforeToolCall blocks
   *  everything else (incl. Think's auto-merged workspace tools). Extend TOOL_ALLOWLIST
   *  in ./logic if you intend to expose read-only MCP tools. */
  getTools() {
    return {
      start_mission: tool({
        description:
          "Queue an approval-gated build mission. Returns an instance id; NOTHING runs until the founder approves. Use when the founder asks to build/change something.",
        inputSchema: z.object({
          title: z.string().describe("short mission title"),
          goal: z.string().describe("what the mission should achieve"),
          repo: z.string().optional().describe("target repo path or url"),
        }),
        execute: async ({ title, goal, repo }) => {
          const instanceId = await this.startMission({ title, goal, repo, requestedBy: "operator" });
          return { instanceId, status: "awaiting founder approval" };
        },
      }),
    };
  }

  /** Init ledger/dedup tables, schedule the daily brief once, wire MCP. */
  async onStart(): Promise<void> {
    await super.onStart();
    this.sql`CREATE TABLE IF NOT EXISTS budget (day TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0)`;
    this.sql`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS seen_events (event_id TEXT PRIMARY KEY, at TEXT DEFAULT (datetime('now')))`;
    const marked = this.sql<{ value: string }>`SELECT value FROM settings WHERE key = 'brief_scheduled'`;
    if (!marked.length) {
      await this.schedule("0 8 * * *", "dailyBrief", {});
      this.sql`INSERT INTO settings (key, value) VALUES ('brief_scheduled','1') ON CONFLICT(key) DO NOTHING`;
    }
    await this.wireMcp();
  }

  private async wireMcp(): Promise<void> {
    const servers: Array<[string, string | undefined]> = [
      ["linear", this.env.MCP_LINEAR_URL],
      ["notion", this.env.MCP_NOTION_URL],
      ["qmd", this.env.MCP_QMD_URL],
      ["scanbox", this.env.MCP_SCANBOX_URL],
    ];
    for (const [name, url] of servers) {
      if (!url) continue;
      try {
        await this.addMcpServer(name, url, {
          transport: this.env.MCP_TOKEN ? { headers: { Authorization: `Bearer ${this.env.MCP_TOKEN}` } } : undefined,
        });
      } catch (e) {
        // a down MCP server must not break startup
        logError("wireMcp.failed", { server: name, err: String((e as Error)?.message ?? e) });
      }
    }
  }

  /* --------------------------- budget governor --------------------------- */

  private usdSpentToday(): number {
    const row = this.sql<{ usd: number }>`SELECT usd FROM budget WHERE day = ${utcDay()}`;
    const first = row[0];
    return first ? Number(first.usd) : 0;
  }

  private recordUsd(usd: number): void {
    this.sql`INSERT INTO budget (day, usd) VALUES (${utcDay()}, ${usd}) ON CONFLICT(day) DO UPDATE SET usd = usd + ${usd}`;
  }

  /** Fail-closed daily-budget predicate (blank/NaN/≤0 cap ⇒ over budget). */
  private overBudget(): boolean {
    return computeOverBudget(Number(this.env.DAILY_USD_BUDGET), this.usdSpentToday());
  }

  /**
   * Warn the founder ONCE per UTC day when the daily AI budget is hit. We mark the day
   * 'warned' BEFORE sending (so a concurrent turn can't double-warn), then roll the mark
   * back if the send fails — so a failed Slack post retries next turn instead of
   * suppressing the warning for the whole day. Fail-soft: never breaks a turn.
   */
  private async maybeWarnBudget(): Promise<void> {
    if (!this.overBudget()) return;
    const day = utcDay();
    const warned = this.sql<{ value: string }>`SELECT value FROM settings WHERE key = 'budget_warned'`;
    if (warned[0]?.value === day) return;
    // Optimistically claim the warn slot for today (prevents a concurrent double-warn).
    this.sql`INSERT INTO settings (key, value) VALUES ('budget_warned', ${day}) ON CONFLICT(key) DO UPDATE SET value = ${day}`;
    const msg =
      `:warning: *Ishtar (operator) hit its daily AI budget* — $${this.usdSpentToday().toFixed(2)} of $${this.env.DAILY_USD_BUDGET} on ${day} (UTC).\n` +
      `I've paused inference until the 00:00 UTC reset. Bump DAILY_USD_BUDGET and redeploy to keep going today.`;
    let sent = false;
    try {
      const { slackDmUser, slackPostMessage } = await import("./slack");
      if (this.env.SLACK_FOUNDER_USER_ID) sent = await slackDmUser(this.env.SLACK_BOT_TOKEN, this.env.SLACK_FOUNDER_USER_ID, msg);
      else if (this.env.SLACK_BRIEF_CHANNEL) sent = await slackPostMessage(this.env.SLACK_BOT_TOKEN, this.env.SLACK_BRIEF_CHANNEL, msg);
    } catch {
      /* warning is best-effort */
    }
    // Roll back the mark if nothing was actually delivered, so we retry next turn.
    if (!sent) this.sql`DELETE FROM settings WHERE key = 'budget_warned' AND value = ${day}`;
  }

  /* --------------------------- Think hooks ------------------------------- */

  /** Hard budget stop before any turn (fail-closed). */
  async beforeTurn(): Promise<void> {
    if (this.overBudget()) {
      await this.maybeWarnBudget();
      throw new Error(`daily AI budget reached ($${this.env.DAILY_USD_BUDGET})`);
    }
  }

  /** Record spend per step from reported usage. */
  async onStepFinish(ctx: { usage?: { inputTokens?: number; outputTokens?: number } }): Promise<void> {
    try {
      const p = PRICING[this.activeModel()] ?? DEFAULT_PRICE;
      const tin = ctx.usage?.inputTokens ?? 0;
      const tout = ctx.usage?.outputTokens ?? 0;
      if (tin || tout) this.recordUsd((tin / 1e6) * p.in + (tout / 1e6) * p.out);
      await this.maybeWarnBudget();
    } catch {
      /* ledger best-effort */
    }
  }

  onChatError(error: unknown): unknown {
    const msg = String((error as Error)?.message ?? error);
    if (msg.includes("budget")) return new Error("I've hit my daily AI budget — bump DAILY_USD_BUDGET or wait for the UTC reset.");
    return new Error("Something went wrong on my side — try again.");
  }

  /* --------------------------- Slack turn -------------------------------- */

  /**
   * One Slack event → de-dup → schedule the turn. Single RPC from /slack (run in
   * waitUntil after a fast 200). Returns "queued", or null if it's a duplicate delivery.
   */
  async handleSlackEvent(p: { eventId?: string; text: string; threadKey: string; channel: string }): Promise<string | null> {
    if (p.eventId) {
      const existing = this.sql<{ x: number }>`SELECT 1 AS x FROM seen_events WHERE event_id = ${p.eventId}`;
      if (existing.length) return null;
      this.sql`INSERT OR IGNORE INTO seen_events (event_id) VALUES (${p.eventId})`;
      // Opportunistic prune — Slack's retry window is minutes; a week is ample. Keeps
      // the dedup table bounded without a separate sweep.
      this.sql`DELETE FROM seen_events WHERE at < datetime('now','-7 days')`;
    }
    // Hand the model turn to the DO's OWN scheduler (immediate alarm). The Worker acks
    // Slack in <3s and its waitUntil finishes fast; the turn then runs on the Durable
    // Object's lifetime — NOT the Worker request's waitUntil, which CF cancels at ~30s.
    try {
      await this.schedule(0, "runSlackTurn", { text: p.text, threadKey: p.threadKey, channel: p.channel });
    } catch (e) {
      // Scheduling failed AFTER we marked the event seen → roll back the dedup row so a
      // Slack redelivery can retry, instead of silently dropping the turn.
      if (p.eventId) this.sql`DELETE FROM seen_events WHERE event_id = ${p.eventId}`;
      logError("handleSlackEvent.scheduleFailed", { err: String((e as Error)?.message ?? e) });
      throw e;
    }
    return "queued";
  }

  /** The actual Slack turn (runs via this.schedule() → DO alarm, own lifetime). */
  async runSlackTurn(p: { text: string; threadKey: string; channel: string }): Promise<void> {
    const { scrubSecrets, slackPostMessage } = await import("./slack");
    if (this.overBudget()) {
      await slackPostMessage(
        this.env.SLACK_BOT_TOKEN,
        p.channel,
        `I've hit my daily AI budget ($${this.env.DAILY_USD_BUDGET}). Bump it or wait for the UTC reset.`,
        p.threadKey || undefined,
      );
      await this.maybeWarnBudget();
      return;
    }
    // Complexity router: pick light vs brain for THIS turn before the loop starts.
    this.routeTurn(p.text);
    let reply = "(no reply)";
    try {
      // Think runs the agentic loop + persists the assistant message into the
      // Session; saveMessages returns only status, so read the reply back from
      // this.messages (the Session getter).
      const result = await this.saveMessages([
        { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: p.text }] },
      ]);
      if (result.status === "completed") {
        const msgs = this.messages as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>;
        const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
        reply = uiText(lastAssistant) || "(no reply)";
      } else {
        logError("runSlackTurn.notCompleted", { status: result.status, err: (result as { error?: string }).error });
        reply = "I hit a snag finishing that — try me again.";
      }
    } catch (e) {
      logError("runSlackTurn.threw", { err: String((e as Error)?.message ?? e) });
      reply = "Something went wrong on my side — try again.";
    }
    reply = scrubSecrets(reply) || "(no reply)";
    await slackPostMessage(this.env.SLACK_BOT_TOKEN, p.channel, reply, p.threadKey || undefined);
  }

  /* --------------------------- daily briefer ----------------------------- */

  async dailyBrief(): Promise<void> {
    const channel = this.env.SLACK_BRIEF_CHANNEL;
    if (!channel) return;
    const spend = this.usdSpentToday();
    const summary =
      `*Ishtar daily brief* — ${utcDay()}\n` +
      `• operator AI spend today: $${spend.toFixed(4)}\n` +
      `• missions awaiting approval: ask me "status".\n` +
      `• (venue cohort + Linear land here once MCP tools are wired)`;
    const { slackPostMessage } = await import("./slack");
    await slackPostMessage(this.env.SLACK_BOT_TOKEN, channel, summary);
  }

  /* --------------------------- orchestrator ------------------------------ */

  /** Queue a build mission. Dynamic Workflows path when DYNAMIC_MISSIONS=true, else GA. */
  async startMission(params: MissionParams): Promise<string> {
    if (this.env.DYNAMIC_MISSIONS === "true") {
      return triggerDynamicMission(this.env, params);
    }
    return this.runWorkflow("MISSION_WORKFLOW", params, {
      metadata: { requestedBy: params.requestedBy, title: params.title },
    });
  }

  async approveMission(instanceId: string, by: string): Promise<void> {
    if (this.env.DYNAMIC_MISSIONS === "true") {
      // Dynamic missions block on step.waitForEvent({ type: "approval" }). A decision is
      // ONE "approval" event carrying an `approved` boolean — reject is NOT a separate
      // type (mirrors the agents-SDK approveWorkflow/rejectWorkflow wire). The event
      // TYPE must match the wait's `type`, or the mission never unblocks.
      const instance = await this.env.DYNAMIC_WORKFLOWS.get(instanceId);
      await instance.sendEvent({ type: "approval", payload: { approved: true, by } });
      return;
    }
    await this.approveWorkflow(instanceId, { reason: "founder approved", metadata: { by } });
  }

  async rejectMission(instanceId: string, reason: string): Promise<void> {
    if (this.env.DYNAMIC_MISSIONS === "true") {
      const instance = await this.env.DYNAMIC_WORKFLOWS.get(instanceId);
      await instance.sendEvent({ type: "approval", payload: { approved: false, reason } });
      return;
    }
    await this.rejectWorkflow(instanceId, { reason });
  }

  // NOTE: onWorkflowProgress/onWorkflowComplete fire ONLY for the GA runWorkflow() path.
  // On the Worker-Loader dynamic path (DYNAMIC_MISSIONS="true") there is no Agent stub to
  // bridge progress back, so these do NOT fire for dynamic missions — a queued dynamic
  // mission surfaces no progress/complete ping here (unbuilt prerequisite, see DEPLOY.md).
  async onWorkflowProgress(_workflowName: string, instanceId: string, progress: unknown): Promise<void> {
    const channel = this.env.SLACK_BRIEF_CHANNEL;
    if (!channel) return;
    const { scrubSecrets, slackPostMessage } = await import("./slack");
    const body = scrubSecrets(`mission ${instanceId}: ${JSON.stringify(progress).slice(0, 500)}`);
    await slackPostMessage(this.env.SLACK_BOT_TOKEN, channel, body);
  }

  async onWorkflowComplete(_workflowName: string, instanceId: string): Promise<void> {
    const channel = this.env.SLACK_BRIEF_CHANNEL;
    if (!channel) return;
    const { scrubSecrets, slackPostMessage } = await import("./slack");
    await slackPostMessage(this.env.SLACK_BOT_TOKEN, channel, scrubSecrets(`mission ${instanceId} complete ✅`));
  }
}

/** Flatten a Think/AI-SDK UIMessage's text parts into a string. */
function uiText(message: { parts?: Array<{ type?: string; text?: string }> } | undefined): string {
  if (!message?.parts) return "";
  return message.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
}

const OPERATOR_SYSTEM = [
  "You are Ishtar, the founder-facing OPERATOR for the Numetal / Ishtar project,",
  "talking PRIVATELY with the founder (Gökhan) in Slack — a trusted, signature-verified",
  "channel. You operate the live Ishtar dating venue and the build process; you do NOT",
  "run matching yourself (the venue Worker owns that). Be a sharp chief-of-staff: candid,",
  "concise, specific. No corporate filler.",
  "",
  "COMMANDS you understand: status · brief · plan <goal> · mission <goal> (use the",
  "start_mission tool) · approve <id> · reject <id> <reason> · hold <thing>.",
  "",
  "THE HARD BOUNDARY — propose, don't act. You may read, summarise, plan, and PROPOSE.",
  "You may NOT deploy, move money, reveal a human contact, change access, or post",
  "externally. Those are founder-gated behind a Workflow approval. Never claim to have",
  "done one — say 'queued for your approval' and surface the id.",
  "",
  "CHAPERONE oversight: when reviewing venue safety, never put PII in chat (use counts +",
  "report ids); focus on coercion/deception/minors/harassment, not consenting-adult age gaps.",
  "",
  "HARD RULES: never output any API key, token, secret, bearer, or seed (you don't have",
  "them); you are Ishtar, not a human and not Gökhan; discuss $NUMETAL plainly but make NO",
  "price/return/profit/financial-promise claims.",
].join("\n");
