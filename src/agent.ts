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
 * deploy/money/reveal/external-post are founder-gated behind a Workflow approval ·
 * no treasury key in this runtime · secrets never echoed (index.ts scrubs Slack out).
 */
import { Think } from "@cloudflare/think";
import { tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { Env } from "./env";
import { triggerDynamicMission } from "./mission-dynamic";

const utcDay = (): string => new Date().toISOString().slice(0, 10);

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

// ---- Complexity router (light tier) --------------------------------------
// AI Gateway Dynamic Routing is rule-based (plan/rate-limit/budget/AB) and CANNOT
// read the prompt; the only prompt-aware "auto" router is OpenRouter Auto, which is
// non-deterministic and unsafe mid-tool-loop. So the router lives HERE, in-agent:
// a conservative, brain-by-default gate that diverts only OBVIOUSLY trivial turns to
// the cheap LIGHT model. Bias is correctness — when in doubt, the brain answers.
const LIGHT_INTENTS = new Set([
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
const BRAIN_KEYWORDS = /\b(status|brief|plan|mission|build|deploy|approve|reject|hold|fix|write|create|review|scan|repo|why|how|what|when|who|which|analy|summ|draft|propose|check|run|update|migrat|cost|budget|spend)\b/i;

/** One mission spec the orchestrator hands to a Workflow. */
export interface MissionParams {
  title: string;
  goal: string;
  repo?: string;
  requestedBy: string;
}

export class OperatorAgent extends Think<Env> {
  /** Model id the router picked for the CURRENT turn. getModel reads it; routeTurn
   *  sets it at turn start, then it sticks for the whole turn (never swap mid-loop —
   *  that breaks tool-call formatting). Defaults to the brain when unset. */
  private routedModel?: string;

  /** The id of the model that should run right now (routed light tier or brain). */
  private activeModel(): string {
    return this.routedModel ?? this.env.CHAT_MODEL;
  }

  /**
   * Complexity router: pick the LIGHT model for a turn ONLY when the message is
   * obviously trivial (a known greeting/ack/presence-check, ≤6 words, no brain
   * keyword). Everything else — every question, command, or longer turn — gets the
   * brain. Conservative on purpose: a misroute-to-light costs quality, a
   * misroute-to-brain only costs a few cents. Routes ONCE per turn.
   */
  private routeTurn(text: string): void {
    const light = this.env.LIGHT_MODEL;
    if (!light) {
      this.routedModel = undefined;
      return;
    }
    const norm = text.trim().toLowerCase().replace(/[.!?,]+$/, "").replace(/\s+/g, " ");
    const trivial = LIGHT_INTENTS.has(norm) || (norm.split(" ").length <= 6 && LIGHT_INTENTS.has(norm.replace(/[^a-z ]/g, "").trim()));
    const wantsBrain = BRAIN_KEYWORDS.test(text);
    this.routedModel = trivial && !wantsBrain ? light : undefined;
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

  /** Tools the operator may call. `start_mission` queues an approval-gated build mission. */
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
    const marked = this.sql`SELECT value FROM settings WHERE key = 'brief_scheduled'` as unknown as { value: string }[];
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
      } catch {
        /* a down MCP server must not break startup */
      }
    }
  }

  /* --------------------------- budget governor --------------------------- */

  private usdSpentToday(): number {
    const row = this.sql`SELECT usd FROM budget WHERE day = ${utcDay()}` as unknown as { usd: number }[];
    return row.length ? Number(row[0].usd) : 0;
  }

  private recordUsd(usd: number): void {
    this.sql`INSERT INTO budget (day, usd) VALUES (${utcDay()}, ${usd}) ON CONFLICT(day) DO UPDATE SET usd = usd + ${usd}`;
  }

  private overBudget(): boolean {
    const cap = Number(this.env.DAILY_USD_BUDGET);
    const budget = Number.isFinite(cap) && cap > 0 ? cap : 0;
    return budget <= 0 || this.usdSpentToday() >= budget;
  }

  /**
   * Warn the founder ONCE per UTC day when the daily AI budget is hit. Idempotent
   * via a `budget_warned` settings row holding the already-warned day, so repeated
   * turns after the cap don't spam. Fail-soft: a failed Slack post never breaks a turn.
   */
  private async maybeWarnBudget(): Promise<void> {
    if (!this.overBudget()) return;
    const day = utcDay();
    const warned = this.sql`SELECT value FROM settings WHERE key = 'budget_warned'` as unknown as { value: string }[];
    if (warned.length && warned[0].value === day) return;
    // Mark BEFORE sending so a concurrent turn can't double-warn.
    this.sql`INSERT INTO settings (key, value) VALUES ('budget_warned', ${day}) ON CONFLICT(key) DO UPDATE SET value = ${day}`;
    const msg =
      `:warning: *Ishtar (operator) hit its daily AI budget* — $${this.usdSpentToday().toFixed(2)} of $${this.env.DAILY_USD_BUDGET} on ${day} (UTC).\n` +
      `I've paused inference until the 00:00 UTC reset. Bump DAILY_USD_BUDGET and redeploy to keep going today.`;
    try {
      const { slackDmUser, slackPostMessage } = await import("./slack");
      if (this.env.SLACK_FOUNDER_USER_ID) await slackDmUser(this.env.SLACK_BOT_TOKEN, this.env.SLACK_FOUNDER_USER_ID, msg);
      else if (this.env.SLACK_BRIEF_CHANNEL) await slackPostMessage(this.env.SLACK_BOT_TOKEN, this.env.SLACK_BRIEF_CHANNEL, msg);
    } catch {
      /* warning is best-effort */
    }
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
   * One Slack event → de-dup → Think turn → scrub → post. Single RPC from /slack
   * (run in waitUntil after a fast 200). Returns the reply, or null if dup/over-budget.
   */
  async handleSlackEvent(p: { eventId?: string; text: string; threadKey: string; channel: string }): Promise<string | null> {
    if (p.eventId) {
      const existing = this.sql`SELECT 1 AS x FROM seen_events WHERE event_id = ${p.eventId}` as unknown as { x: number }[];
      if (existing.length) return null;
      this.sql`INSERT OR IGNORE INTO seen_events (event_id) VALUES (${p.eventId})`;
    }
    // Hand the model turn to the DO's OWN scheduler (immediate alarm). The Worker
    // acks Slack in <3s and its waitUntil finishes fast; the turn then runs on the
    // Durable Object's lifetime — NOT the Worker request's waitUntil, which CF
    // cancels at ~30s and was killing the turn before it could post a reply.
    await this.schedule(0, "runSlackTurn", { text: p.text, threadKey: p.threadKey, channel: p.channel });
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
        console.error("slack turn not completed:", result.status, (result as { error?: string }).error);
        reply = "I hit a snag finishing that — try me again.";
      }
    } catch (e) {
      console.error("slack turn threw:", e);
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

  async onWorkflowProgress(_workflowName: string, instanceId: string, progress: unknown): Promise<void> {
    const channel = this.env.SLACK_BRIEF_CHANNEL;
    if (!channel) return;
    const { slackPostMessage } = await import("./slack");
    await slackPostMessage(this.env.SLACK_BOT_TOKEN, channel, `mission ${instanceId}: ${JSON.stringify(progress).slice(0, 500)}`);
  }

  async onWorkflowComplete(_workflowName: string, instanceId: string): Promise<void> {
    const channel = this.env.SLACK_BRIEF_CHANNEL;
    if (!channel) return;
    const { slackPostMessage } = await import("./slack");
    await slackPostMessage(this.env.SLACK_BOT_TOKEN, channel, `mission ${instanceId} complete ✅`);
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
