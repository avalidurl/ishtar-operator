# ishtar-operator

**Ishtar-the-Agent** — the founder-facing operator brain for the Numetal / Ishtar
project, as a **Project Think agent** on the Cloudflare Agents SDK (an `Agent` *is* a
Durable Object). It re-platforms the old OpenClaw-on-Hetzner brain onto Cloudflare. It
**operates** the live Ishtar dating venue and the build process; it does **not** run
matching (the venue Worker's `MatchCoordinator` DO owns that).

Plan + rationale: vault `projects/numetal/ishtar/ishtar-agent/cf-migration-plan-2026-06-28.md`.

## What it is
- **Harness:** **Project Think** (`@cloudflare/think@0.10.0`). `OperatorAgent extends Think` — Think owns the agentic loop, Session memory, streaming, and tools; we provide `getModel()` / `getSystemPrompt()` / `getTools()` + lifecycle hooks. Think extends `Agent`, so `this.schedule` / `this.sql` / `this.runWorkflow` / `this.addMcpServer` are all available.
- **Brain:** Workers AI (`@cf/zai-org/glm-5.2`, open-weight) through the **`datebook` AI Gateway** — `getModel()` uses `createWorkersAI({ binding: this.env.AI, gateway: { id } })`. Dollar cap + logs in the dashboard. **No OpenAI API.** Daily USD budget hard-stop via `beforeTurn`; spend recorded in `onStepFinish`; fail-closed.
- **Control surface:** **Slack HTTP Events API** (`POST /slack`) — signature-verified (HMAC-SHA256) + team/founder allowlist, ack-fast + `waitUntil`, routed by `team_id` to the workspace's Think DO, which runs a turn (`saveMessages`) and posts the reply.
- **Build orchestration — two live engines:**
  - **GA Workflow** (`MissionWorkflow`, `agents/workflows`): plan → `waitForApproval` → work-order. Default-safe.
  - **Dynamic Workflows** (`mission-dynamic.ts`, `@cloudflare/dynamic-workflows`): the operator GENERATES a per-mission Workflow module at runtime (plain JS, no bundler) and runs it durably via a Worker Loader. **ON** (`DYNAMIC_MISSIONS="true"`); `startMission` routes here.

## The five roles
`operator` (Slack chat) · `daily-brief` (`this.schedule` 08:00 UTC) · `repo-mission-dispatch` (the two Workflow engines + `start_mission` tool) · `chaperone-decision` (MCP read + propose) · `evaluator` (`this.sql` ledger). Authored as agentskills.io `SKILL.md` playbooks in `./skills` (portable across Pi/Flue/Claude/CF) and embedded into the Think system prompt as always-on behavior (per CF's guidance: always-on → system prompt; on-demand → `getSkills()`).

## Surface
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness |
| `POST /slack` | Slack signature | founder chat (events API) → Think turn |
| `POST /admin/mission` | founder bearer | queue a build mission (GA or dynamic per `DYNAMIC_MISSIONS`) |
| `POST /admin/missions/:id/approve\|reject` | founder bearer | act on a waiting mission |
| `POST /admin/brief` | founder bearer | run the daily brief now |
| `*` | — | `routeAgentRequest` (Think chat RPC/WS) |

## Verify
```
pnpm install
pnpm typecheck   # tsc --noEmit → 0
pnpm test        # vitest → Slack signature + scrub helpers (6)
pnpm dry-run     # wrangler deploy --dry-run → bindings OK
```
Verified green 2026-06-28: typecheck 0 · 6/6 tests · dry-run binds OperatorAgent (DO) + MISSION_WORKFLOW + DYNAMIC_WORKFLOWS (Workflows) + AI + LOADER (Worker Loader) + vars (1131 KiB gzip).

## Deps (all 7-day-freshness-compliant, ≤ 2026-06-21)
`@cloudflare/think@0.10.0` · `agents@0.16.2` (matched pair) · `ai@6.0.208` · `zod@4.4.3` · `workers-ai-provider@3.2.0` · `@cloudflare/dynamic-workflows@0.1.1` · `hono@4.12.25` · dev: `wrangler@4.103.0`, `@cloudflare/workers-types@4.20260617.1`.

## Status
Scaffold complete + verified green. **Not deployed** (founder-gated — see DEPLOY.md).
**Dynamic Workflows is ON**: `wrangler deploy` needs the **Worker Loader open-beta entitlement** on the account (Workers Paid). dry-run does not. The generated mission module is OUR template (no untrusted model-authored code executed); if you later feed model-authored steps in, sandbox + review them first.

## Notes
- `@cf/zai-org/glm-5.2` is an **open-weight** model (Zhipu AI) on Workers AI — not the OpenAI API. No consumer-subscription / ToS issue (the gateway can't carry a subscription anyway). Alternatives: `@cf/nvidia/nemotron-3-120b-a12b`, `@cf/moonshotai/kimi-k2.7-code`.
- The treasury/signing key never lives in this runtime. The operator proposes; the founder executes irreversible actions.
- A browser chat console is a drop-in later (Think speaks the `useAgentChat` WebSocket protocol via `routeAgentRequest`).
