/**
 * index.ts — Worker entrypoint for the Ishtar operator brain.
 *
 * Surface:
 *  - GET  /health                      — liveness (no secret, no echo).
 *  - POST /slack                       — Slack HTTP Events API. Signature-verified
 *                                        (HMAC-SHA256) + team/founder allowlist;
 *                                        acks 200 fast, runs the turn in waitUntil,
 *                                        routes by team_id to the workspace's Agent DO.
 *  - POST /admin/mission              — founder: start an approval-gated build mission.
 *  - POST /admin/missions/:id/approve — founder: approve a waiting mission.
 *  - POST /admin/missions/:id/reject  — founder: reject a waiting mission.
 *  - POST /admin/brief                — founder: run the daily brief now (test).
 *  - *                                — routeAgentRequest fallback (the Agent's own
 *                                        RPC/WebSocket protocol at /agents/...).
 *
 * The DO class (OperatorAgent) and the Workflow class (MissionWorkflow) are
 * exported here so Wrangler can bind them.
 */
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { OperatorAgent } from "./agent";
import type { Env } from "./env";
import { type SlackEnvelope, timingSafeEqual, verifySlackSignature } from "./slack";

export { OperatorAgent } from "./agent";
export { MissionWorkflow } from "./missions";
// Dynamic Workflows engine (LIVE when DYNAMIC_MISSIONS="true"). Both classes must be
// exported from the entry so Wrangler binds DYNAMIC_WORKFLOWS + the loader RPC stubs.
export { DynamicWorkflowBinding, DynamicMissionWorkflow } from "./mission-dynamic";

const app = new Hono<{ Bindings: Env }>();

/** Defense-in-depth headers; admin responses never cached. */
app.use("*", async (c, next) => {
  await next();
  try {
    c.res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
    if (c.req.path.startsWith("/admin")) c.res.headers.set("cache-control", "no-store, private");
  } catch {
    /* immutable headers on some responses */
  }
});

/** Founder gate: Authorization: Bearer <ACCESS_KEY>, constant-time. Fail closed. */
function isFounder(c: { req: { header: (k: string) => string | undefined }; env: Env }): boolean {
  const key = c.env.ACCESS_KEY;
  if (typeof key !== "string" || key.length === 0) return false;
  const auth = c.req.header("authorization");
  if (!auth) return false;
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return bearer.length > 0 && timingSafeEqual(bearer, key);
}

app.get("/health", (c) => c.json({ ok: true, service: "ishtar-operator" }));

app.post("/slack", async (c) => {
  const raw = await c.req.text();

  let body: SlackEnvelope;
  try {
    body = JSON.parse(raw) as SlackEnvelope;
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }

  // Slack URL-verification handshake — echo the challenge BEFORE the signature
  // check. The challenge is a random token Slack sends at setup; reflecting it
  // leaks nothing and changes no state, and answering it first lets the endpoint
  // verify even while the signing secret is still being sorted. REAL events are
  // signature-checked below (the handshake is the only pre-signature path).
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return c.json({ challenge: body.challenge });
  }

  // All real events MUST pass signature verification.
  const ok = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("x-slack-request-timestamp"),
    raw,
    c.req.header("x-slack-signature"),
  );
  if (!ok) return c.json({ error: "bad_signature" }, 401);

  if (body.type === "event_callback" && body.event) {
    const ev = body.event;
    const isMention = ev.type === "app_mention";
    const isDM = ev.type === "message" && ev.channel_type === "im";
    const ignorable = ev.bot_id || ev.subtype;
    // Founder/team allowlist (fail-closed when configured).
    const teamOk = !c.env.SLACK_TEAM_ID || body.team_id === c.env.SLACK_TEAM_ID;
    const userOk = !c.env.SLACK_FOUNDER_USER_ID || ev.user === c.env.SLACK_FOUNDER_USER_ID;

    if ((isMention || isDM) && !ignorable && teamOk && userOk && ev.channel) {
      const text = String(ev.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const threadKey = ev.thread_ts ?? ev.ts ?? "";
      const team = body.team_id ?? "operator";
      const channel = ev.channel;
      const eventId = body.event_id;
      if (text) {
        // Ack within Slack's 3s window; do the model work out of band.
        c.executionCtx.waitUntil(
          (async () => {
            try {
              const agent = await getAgentByName(c.env.OperatorAgent, team);
              await agent.handleSlackEvent({ eventId, text, threadKey, channel });
            } catch {
              /* lands in Workers Logs; never fails the ack */
            }
          })(),
        );
      }
    }
  }
  return c.json({ ok: true });
});

/* ------------------------------- admin -------------------------------- */

async function adminAgent(c: { env: Env; req: { query: (k: string) => string | undefined } }) {
  const team = c.req.query("team") ?? "operator";
  return getAgentByName(c.env.OperatorAgent, team);
}

app.post("/admin/mission", async (c) => {
  if (!isFounder(c)) return c.json({ error: "unauthorized" }, 401);
  const b = (await c.req.json().catch(() => ({}))) as { title?: string; goal?: string; repo?: string; requestedBy?: string };
  if (!b.title || !b.goal) return c.json({ error: "title + goal required" }, 400);
  const agent = await adminAgent(c);
  const instanceId = await agent.startMission({
    title: b.title,
    goal: b.goal,
    repo: b.repo,
    requestedBy: b.requestedBy ?? "founder",
  });
  return c.json({ ok: true, instanceId });
});

app.post("/admin/missions/:id/approve", async (c) => {
  if (!isFounder(c)) return c.json({ error: "unauthorized" }, 401);
  const agent = await adminAgent(c);
  await agent.approveMission(c.req.param("id"), "founder");
  return c.json({ ok: true });
});

app.post("/admin/missions/:id/reject", async (c) => {
  if (!isFounder(c)) return c.json({ error: "unauthorized" }, 401);
  const b = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const agent = await adminAgent(c);
  await agent.rejectMission(c.req.param("id"), b.reason ?? "rejected");
  return c.json({ ok: true });
});

app.post("/admin/brief", async (c) => {
  if (!isFounder(c)) return c.json({ error: "unauthorized" }, 401);
  const agent = await adminAgent(c);
  await agent.dailyBrief();
  return c.json({ ok: true });
});

/* ----------------------- no public Agents transport ------------------- */

// SECURITY (audit 2026-06-28, HIGH): we do NOT expose routeAgentRequest. The
// operator has no browser/WebSocket client — the founder talks ONLY via /slack.
// Handing the catch-all to routeAgentRequest published the Durable Object's
// UNAUTHENTICATED Agents-SDK WebSocket: an anonymous connect got a full
// `cf_agent_state` dump + the internal `cf_agent_mcp_servers` URLs, and the
// connection was read-WRITE by default (shouldConnectionBeReadonly() => false).
// The Hetzner box was Tailscale-only and structurally never had this. Unknown
// paths now 404. (getAgentByName still works — it's the binding, not this route.)
app.all("*", (c) => c.json({ error: "not_found" }, 404));

export default app;
