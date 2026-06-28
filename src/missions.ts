/**
 * missions.ts — the build-orchestrator's GA durable mission engine.
 *
 * Cloudflare Workflows (GA) via the Agents SDK AgentWorkflow base. A mission is:
 *   plan → REPORT → BLOCK on founder approval → emit a work-order → complete.
 *
 * Founder-gated BY CONSTRUCTION: the Workflow halts at this.waitForApproval until
 * the founder approves (OperatorAgent.approveMission / POST /admin/missions/:id).
 * The "execute" step does NOT deploy, merge, move money, or run agent-generated
 * code — it emits a structured work-order that a Factory droid / Codex run carries
 * out under separate founder review. This is the safe, GA path. (The runtime-
 * generated-code variant lives in mission-dynamic.ts, off by default.)
 */
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { MissionParams, OperatorAgent } from "./agent";

interface WorkOrder {
  title: string;
  goal: string;
  repo?: string;
  steps: string[];
  approvedBy?: string;
  emittedAt: number;
}

export class MissionWorkflow extends AgentWorkflow<OperatorAgent, MissionParams> {
  async run(event: AgentWorkflowEvent<MissionParams>, step: AgentWorkflowStep): Promise<WorkOrder | { rejected: true; reason: string }> {
    const p = event.payload;

    // 1. Plan — decompose the goal into a fixed, reviewable step list. (A richer
    //    planner could call the model via the agent RPC; kept deterministic here.)
    const plan = await step.do("plan", async () => {
      return [
        "clone + branch the target repo",
        "implement the change to production spec (tests first)",
        "run typecheck + tests + wrangler dry-run",
        "open a PR with risk notes",
        "await founder review → merge → founder-run deploy",
      ];
    });

    await this.reportProgress({ step: "approval", status: "pending", message: `Mission "${p.title}" awaiting founder approval` });

    // 2. Founder approval gate — BLOCKS here (up to 7 days). Throws on reject.
    let approvedBy = "unknown";
    try {
      const approval = await this.waitForApproval<{ by?: string }>(step, { timeout: "7 days" });
      approvedBy = approval?.by ?? "founder";
    } catch (e) {
      await step.reportError(`mission rejected: ${String((e as Error)?.message ?? e)}`);
      return { rejected: true, reason: String((e as Error)?.message ?? "rejected") };
    }

    // 3. Emit the approved work-order (durable). Real execution = a Factory droid /
    //    Codex run picks this up under separate founder review. No deploy here.
    const order: WorkOrder = await step.do("emit-work-order", async () => ({
      title: p.title,
      goal: p.goal,
      repo: p.repo,
      steps: plan,
      approvedBy,
      // Stamped inside step.do → runs once, persisted on success (retry-safe).
      emittedAt: Date.now(),
    }));

    await step.reportComplete(order);
    return order;
  }
}
