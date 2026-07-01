/**
 * mission-template.ts — the pure, runtime-free generator for a dynamic mission's
 * Workflow module (a plain JS string). Kept SEPARATE from mission-dynamic.ts on
 * purpose: this file imports NOTHING from `cloudflare:workers` / the Worker Loader,
 * so the generated code can be unit-tested in the Node vitest pool (test/operator.test.ts)
 * without the Workers runtime. mission-dynamic.ts imports generateMissionModule from here.
 */
import type { MissionParams } from "./agent";

/**
 * Generate the per-mission Workflow module (plain JS string). The plan steps are
 * templated from the goal → genuinely runtime-generated workflow code. The Workflow
 * BLOCKS on `step.waitForEvent(name, { type: "approval" })` so nothing past planning
 * runs until the founder decides. A decision is ONE "approval" event carrying an
 * `approved` boolean (operator.approveMission / rejectMission → instance.sendEvent),
 * mirroring the agents-SDK approveWorkflow/rejectWorkflow wire. A timed-out wait
 * throws → the mission fails CLOSED (never emits a work-order without approval).
 *
 * The event's `type` is load-bearing: CF Workflows match `sendEvent` to `waitForEvent`
 * by `type`, so a TYPELESS wait (the prior bug) could never be satisfied by
 * `sendEvent({ type: "approval" })` — the mission just blocked to the 7-day timeout.
 */
export function generateMissionModule(params: MissionParams): string {
  const plan = [
    "clone + branch the target repo",
    "implement to production spec (tests first)",
    "typecheck + tests + wrangler dry-run",
    "open a PR with risk notes",
    "await founder review → merge → founder-run deploy",
  ];
  const j = (v: unknown) => JSON.stringify(v);
  return `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class MissionRunner extends WorkflowEntrypoint {
  async run(event, step) {
    const plan = await step.do("plan", async () => (${j(plan)}));
    await step.do("await-approval-note", async () => ({ status: "awaiting founder approval", title: ${j(params.title)} }));
    // Founder gate — blocks until operator.approve/rejectMission sends a matching
    // "approval" event. The event TYPE must be present and equal on both sides (CF
    // matches sendEvent by type); a decision is ONE "approval" event carrying an
    // \`approved\` boolean (approve → true, reject → false), never a separate type.
    // A timed-out wait THROWS, so an un-decided mission fails CLOSED here.
    let decision;
    try {
      decision = await step.waitForEvent("await-founder-approval", { type: "approval", timeout: "7 days" });
    } catch (err) {
      return { rejected: true, reason: "approval timed out — no founder decision in 7 days" };
    }
    const payload = (decision && decision.payload) || {};
    if (!payload.approved) {
      return { rejected: true, reason: payload.reason || "rejected" };
    }
    const order = await step.do("emit-work-order", async () => ({
      title: ${j(params.title)}, goal: ${j(params.goal)}, repo: ${j(params.repo ?? null)},
      steps: plan, approvedBy: payload.by || "founder",
      emittedAt: Date.now(),
    }));
    return order;
  }
}
export default {
  async fetch(request, env) {
    const params = await request.json().catch(() => ({}));
    const instance = await env.WORKFLOWS.create({ params });
    return Response.json({ id: await instance.id });
  },
};
`.trim();
}
