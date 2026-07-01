<div align="center">

# ishtar-operator

**A founder-facing Slack operator agent, scaffolded on the Cloudflare Agents SDK.**

_An `Agent` is a Durable Object — the operator brain, its memory, and its build-orchestration Workflows all live on one Worker._

<br />

[![last commit](https://img.shields.io/github/last-commit/gokhan-vc/ishtar-operator?style=flat-square)](https://github.com/gokhan-vc/ishtar-operator/commits)
[![stars](https://img.shields.io/github/stars/gokhan-vc/ishtar-operator?style=social)](https://github.com/gokhan-vc/ishtar-operator/stargazers)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat-square&logo=cloudflareworkers&logoColor=white)](https://developers.cloudflare.com/workers/)
[![Agents SDK](https://img.shields.io/badge/Agents_SDK-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/agents/)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=flat-square&logo=hono&logoColor=white)](https://hono.dev/)
[![Slack](https://img.shields.io/badge/Slack_Events_API-4A154B?style=flat-square&logo=slack&logoColor=white)](https://api.slack.com/apis/events-api)
[![Vitest](https://img.shields.io/badge/tested_with-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)

</div>

---

> ### ⚠️ ARCHIVED / SUPERSEDED — never deployed, not the source of truth
>
> This repo is a **scaffold** from the 2026-06 re-platforming of the operator brain onto
> Cloudflare. It **was never deployed** and is **not the current source of truth**. It is kept
> as a **migration artifact** for reference. The live operator runs on a separate, privately
> provisioned runtime; its runtime config, deploy topology, and model choice are intentionally
> **not described here**. Do not treat anything in this repo as live infrastructure.

---

## What it is

`ishtar-operator` is a reference scaffold for a **single-founder operator agent** — a private
Slack chief-of-staff that reads, plans, briefs, and **proposes** build work, but never acts
irreversibly on its own. It is the founder-facing control surface for a larger project; it does
**not** run that project's core product logic (in the original design, a separate Worker owns
the live venue and its matching).

The interesting part, and the reason it's worth reading, is the **architecture**: it puts an
LLM agent, its persistent memory, a budget governor, a scheduler, and two durable
build-orchestration engines behind one authenticated Slack endpoint — entirely on Cloudflare's
edge, with no always-on server.

## Highlights

- **Agent = Durable Object.** Built on `@cloudflare/think` (which extends the Cloudflare Agents
  SDK `Agent`). The harness owns the agentic loop, session memory, streaming, and tool-calling;
  the app supplies `getModel()` / `getSystemPrompt()` / `getTools()` plus lifecycle hooks. Because
  it's a DO, `this.schedule`, `this.sql`, `this.runWorkflow`, and `this.addMcpServer` are all
  available on the same object.
- **Signature-verified Slack control surface.** `POST /slack` (Slack HTTP Events API) is
  HMAC-SHA256 signature-verified, gated by a team/founder allowlist, acks within Slack's 3-second
  window, and hands the model turn to the Durable Object's own scheduler so it runs on the DO's
  lifetime rather than the request's.
- **Fail-closed budget governor.** A daily USD ceiling is enforced in a `beforeTurn` hook and
  charged per step in `onStepFinish` against an on-DO SQLite ledger — a runaway-loop money
  backstop, not a spend target. The founder is warned once per day when the cap is hit.
- **Two durable build engines, approval-gated.** A GA Cloudflare **Workflow** (`plan → wait for
  approval → work-order`) and an optional **Dynamic Workflows** path that generates a per-mission
  Workflow module at runtime and runs it durably on a Worker Loader. Nothing runs until the
  founder approves.
- **Propose, don't act.** The system prompt and the admin surface enforce a hard boundary:
  deploy, moving money, revealing a contact, changing access, and posting externally are all
  founder-gated behind a Workflow approval. No treasury/signing key ever enters this runtime.
- **Portable skill playbooks.** The operator's behaviors are authored as
  [agentskills.io](https://agentskills.io) `SKILL.md` files under [`skills/`](skills/) — portable
  across agent runtimes and embedded into the system prompt as always-on behavior.
- **Pluggable tools over MCP.** Optional MCP endpoints are wired in at startup when configured; a
  down MCP server never breaks boot.

## Surface

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness |
| `POST /slack` | Slack signature | founder chat (Events API) → one agent turn |
| `POST /admin/mission` | founder bearer | queue an approval-gated build mission |
| `POST /admin/missions/:id/approve` · `/reject` | founder bearer | act on a waiting mission |
| `POST /admin/brief` | founder bearer | run the daily brief now |
| `*` | — | `404` (no public Agents WebSocket transport is exposed — by design) |

## Architecture at a glance

```
Slack (Events API)                          founder bearer
      │  POST /slack                               │  POST /admin/*
      ▼  (HMAC-verified, allowlisted)              ▼
┌──────────────────────── Worker (Hono router) ───────────────────────┐
│  ack < 3s  ──►  DO scheduler (own lifetime)                          │
└───────────────────────────────┬─────────────────────────────────────┘
                                 ▼
             OperatorAgent  (Durable Object · extends Think · Agents SDK)
             ├─ getModel()  ── Workers AI ── AI Gateway (spend cap + logs)
             ├─ SQLite ledger  ── daily USD budget · event de-dup · settings
             ├─ this.schedule  ── daily brief (cron)
             ├─ getTools()  ── start_mission (approval-gated)
             └─ orchestrator ── GA Workflow  |  Dynamic Workflow (Worker Loader)
```

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (ESM) |
| Runtime | Cloudflare Workers + Durable Objects |
| Agent harness | [`@cloudflare/think`](https://www.npmjs.com/package/@cloudflare/think) on the Cloudflare [Agents SDK](https://developers.cloudflare.com/agents/) (`agents`) |
| LLM plumbing | [Vercel AI SDK](https://sdk.vercel.ai/) (`ai`) + [`workers-ai-provider`](https://www.npmjs.com/package/workers-ai-provider) |
| HTTP router | [Hono](https://hono.dev/) |
| Orchestration | Cloudflare Workflows + [`@cloudflare/dynamic-workflows`](https://www.npmjs.com/package/@cloudflare/dynamic-workflows) on Worker Loaders |
| Validation | [Zod](https://zod.dev/) |
| Inference | Cloudflare Workers AI (through the AI Gateway) |
| Tooling | [Wrangler](https://developers.cloudflare.com/workers/wrangler/), [Vitest](https://vitest.dev/), pnpm |

## Develop

```bash
pnpm install
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest — Slack signature verification + secret-scrub helpers
pnpm dry-run      # wrangler deploy --dry-run — verifies bindings without deploying
pnpm dev          # wrangler dev — local runtime
```

Runtime configuration is provided at deploy time via `wrangler.toml` `[vars]` and
`wrangler secret put …` (never committed). Sensitive workspace/user IDs are left as
placeholders in the committed config on purpose. See [`DEPLOY.md`](DEPLOY.md) for the full
(founder-gated) deploy walkthrough and the open prerequisites noted for any future revival of
this scaffold.

## Security

- Every request path fails **closed**: no bearer / bad signature / over-budget → the turn does
  not run.
- The founder bearer check and Slack signature check use **constant-time** comparison.
- The Durable Object's unauthenticated Agents-SDK WebSocket transport is deliberately **not**
  routed — unknown paths `404` — so agent state and any internal tool URLs are never exposed to
  an anonymous connect.
- Secrets are never placed in `[vars]`, never logged, and outbound replies are scrubbed before
  posting to Slack.

There is no dedicated `SECURITY.md` in this archived scaffold. For any live surface, report
concerns privately to the repository owner rather than opening a public issue.

## Credits & third-party

Built on, and grateful to, the following open-source projects — please consult each project for
its own license:

- **[Cloudflare Agents SDK](https://github.com/cloudflare/agents)** (`agents`) and
  **[`@cloudflare/think`](https://www.npmjs.com/package/@cloudflare/think)** — the agent harness
  (Agent-as-Durable-Object, session memory, tool loop). MIT.
- **[`@cloudflare/dynamic-workflows`](https://www.npmjs.com/package/@cloudflare/dynamic-workflows)**
  and **[Wrangler](https://github.com/cloudflare/workers-sdk)** — durable orchestration and the
  Workers toolchain. MIT / Apache-2.0.
- **[Vercel AI SDK](https://github.com/vercel/ai)** (`ai`) and
  **[`workers-ai-provider`](https://github.com/cloudflare/workers-sdk)** — model plumbing. Apache-2.0 / MIT.
- **[Hono](https://github.com/honojs/hono)** — the HTTP router. MIT.
- **[Zod](https://github.com/colinhacks/zod)** — schema validation. MIT.
- **[Vitest](https://github.com/vitest-dev/vitest)** — the test runner. MIT.
- **[agentskills.io](https://agentskills.io)** — the portable `SKILL.md` playbook format used
  under [`skills/`](skills/).

## License

**License: TBD** — no `LICENSE` file is present in this repository. Until one is added, all
rights are reserved by the repository owner; contact the owner regarding reuse.

---

<div align="center">
<sub>Archived migration scaffold · kept for reference · not live infrastructure.</sub>
</div>
