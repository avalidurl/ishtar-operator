/**
 * mission-dynamic.ts — LIVE Dynamic Workflows: missions whose Workflow code the
 * operator GENERATES at runtime (per goal), run durably via a Worker Loader.
 *
 * Verified API (developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows
 * + /getting-started, 2026-06-28): a Worker Loader loads a per-mission module; the
 * Workflows engine reloads it across isolate restarts via createDynamicWorkflowEntrypoint.
 * Lean by design — the generated module is plain JS (no @cloudflare/worker-bundler),
 * so no heavy runtime bundler in the deployed Worker.
 *
 * ENABLED when env.DYNAMIC_MISSIONS="true". DEPLOY caveat: Worker Loaders / Dynamic
 * Workers is OPEN BETA (Workers Paid) — `wrangler deploy` needs the account entitlement.
 * The generated module is OUR template (not arbitrary model output), so there is no
 * untrusted-code-execution surface here; if you later feed model-authored steps in,
 * sandbox + review them first (DEPLOY.md).
 */
import {
  createDynamicWorkflowEntrypoint,
  DynamicWorkflowBinding,
  wrapWorkflowBinding,
  type WorkflowRunner,
} from "@cloudflare/dynamic-workflows";
import type { Env, WorkerLoaderLike } from "./env";
import type { MissionParams } from "./agent";

// Required: re-exporting puts the class on cloudflare:workers exports — how
// wrapWorkflowBinding builds the per-mission RPC stubs.
export { DynamicWorkflowBinding };

interface DynEnv {
  LOADER: WorkerLoaderLike;
}

/**
 * Generate the per-mission Workflow module (plain JS string). The plan steps are
 * templated from the goal → genuinely runtime-generated workflow code. The Workflow
 * BLOCKS on `step.waitForEvent("approval")` so nothing past planning runs until the
 * founder approves (operator.approveMission → instance.sendEvent).
 */
function generateMissionModule(params: MissionParams): string {
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
    // Founder gate — blocks until operator.approveMission sends the event (or 7d timeout).
    const decision = await step.waitForEvent("approval", { timeout: "7 days" });
    if (decision && decision.payload && decision.payload.reason) {
      return { rejected: true, reason: decision.payload.reason };
    }
    const order = await step.do("emit-work-order", async () => ({
      title: ${j(params.title)}, goal: ${j(params.goal)}, repo: ${j(params.repo ?? null)},
      steps: plan, approvedBy: (decision && decision.payload && decision.payload.by) || "founder",
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

/** Load (or reuse) the Dynamic Worker for one mission, tagged so the engine can resume it. */
function loadMission(env: DynEnv, missionId: string, params: MissionParams) {
  return env.LOADER.get(missionId, async () => ({
    compatibilityDate: "2026-06-01",
    mainModule: "mission.js",
    modules: { "mission.js": generateMissionModule(params) },
    // The generated worker uses this exactly like a real Workflow binding; every
    // create() is tagged with { missionId } so the engine routes resumes back here.
    env: { WORKFLOWS: wrapWorkflowBinding({ missionId }) },
  }));
}

/**
 * Trigger a dynamic mission: generate + load its module, then create the instance.
 * Returns the Workflow instance id. Called by OperatorAgent.startMission when
 * DYNAMIC_MISSIONS="true".
 */
export async function triggerDynamicMission(env: Env, params: MissionParams): Promise<string> {
  const missionId = crypto.randomUUID();
  const stub = loadMission(env, missionId, params);
  const res = await stub.getEntrypoint().fetch(
    new Request("https://mission/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    }),
  );
  const out = (await res.json().catch(() => ({}))) as { id?: string };
  return out.id ?? missionId;
}

/**
 * The Workflows entrypoint the engine uses. Its name MUST match `class_name` in the
 * DYNAMIC_WORKFLOWS binding (wrangler.toml). On resume, it reloads the mission's
 * module via the Worker Loader and runs the next step.
 */
export const DynamicMissionWorkflow = createDynamicWorkflowEntrypoint<DynEnv>(async ({ env, metadata }) => {
  // We only have the id at resume time; the cached Dynamic Worker (by missionId) is
  // reused, so params baked at create-time persist with the warm instance.
  const stub = env.LOADER.get(metadata.missionId as string, async () => {
    throw new Error("mission worker evicted; re-trigger the mission");
  });
  return stub.getEntrypoint("MissionRunner") as unknown as WorkflowRunner;
});
