# DEPLOY — ishtar-operator (founder-gated)

The agent cannot do these (no token provisioning, no secrets, no public deploy). Gökhan runs them.

## 0. Prereqs (one-time)
- Cloudflare auth: `wrangler login` (or a scoped CF token in the env for CI).
- The **`datebook` AI Gateway** must exist with a **dollar spend limit** (dashboard → AI → AI Gateway). Same gateway the venue + intern use, so all spend lands under one cap.

## 1. Secrets (`wrangler secret put …` — never `[vars]`, never logged)
```
wrangler secret put ACCESS_KEY            # founder bearer for /admin/*
wrangler secret put SLACK_SIGNING_SECRET  # verifies POST /slack
wrangler secret put SLACK_BOT_TOKEN       # xoxb-… for chat.postMessage
# optional, when wiring tools:
wrangler secret put MCP_TOKEN             # bearer for authed MCP servers
```
Optional MCP endpoints (set as vars in `wrangler.toml` or secrets) let the operator reach
whatever internal tools you choose to wire in. The endpoint URLs are provided privately at
deploy time and are not enumerated here.

## 2. Slack app (HTTP Events API — NOT Socket Mode)
This is the migration change from the previous self-hosted brain (which used Socket Mode).
1. api.slack.com/apps → create app. **OAuth scopes:** `chat:write`, `chat:write.public`, `channels:history`, `app_mentions:read`, `im:write`, `im:history`.
2. Deploy (step 3) to get the Worker URL, then **Event Subscriptions → Request URL = `https://ishtar-operator.<account>.workers.dev/slack`** (Slack verifies via the signing secret). Subscribe to bot events `app_mention` + `message.im`.
3. Install to the workspace; set `SLACK_TEAM_ID` + `SLACK_FOUNDER_USER_ID` + `SLACK_BRIEF_CHANNEL` in `[vars]` to hard-lock chat + enable the daily brief.

## 3. Deploy
```
pnpm install
pnpm typecheck && pnpm test && pnpm dry-run   # all green before deploy
wrangler deploy
```
First deploy creates the `OperatorAgent` Durable Object (migration `v1`, `new_sqlite_classes`)
and the `MissionWorkflow` Workflow. Then set the Slack Request URL (step 2.2).

## 4. Verify live
- `GET /health` → `{ ok: true }`.
- DM the bot in Slack → a reply (and a row in the `datebook` gateway log, **no OpenAI usage**).
- `POST /admin/mission` (founder bearer) → an instance id; `…/approve` → the work-order emits.
- Trip-test: set a tiny gateway dollar cap → confirm calls fail closed → restore.

## 5. Decommission the previous self-hosted brain
Once a live Slack turn + a daily brief run on CF, **retire the previous self-hosted
operator brain**. If that host also runs other private services, confirm those are
separated or relocated before decommissioning — the CF agent calls them as tools over
their own endpoints. The topology of the private runtime is managed separately and is
intentionally not described in this public doc.

## 6. Dynamic Workflows — ON (needs the Worker Loader entitlement to deploy)
`DYNAMIC_MISSIONS="true"` and the `worker_loaders` + `DYNAMIC_WORKFLOWS` bindings are
**live** in `wrangler.toml` (dry-run green). The only deploy gate is the account entitlement:
1. **Request the Worker Loader / Dynamic Workers open-beta** for the account (Workers Paid). Without it, `wrangler deploy` will reject the `worker_loaders` binding — request it from Cloudflare before the first deploy. (dry-run does not need it.)
2. The generated mission module is OUR template (`mission-dynamic.ts` → `generateMissionModule`). If you later let the MODEL author mission steps, sandbox + review that output before running it.
3. Ensure the bundler preserves class names (no minify) so Workflow routing by `class_name` survives — wrangler does not minify by default, so this holds.
4. To fall back to GA-only missions (deploy without the entitlement), set `DYNAMIC_MISSIONS="false"` and remove the `worker_loaders` + `DYNAMIC_WORKFLOWS` bindings.

## 7. Private connectivity to internal tools

If the operator needs to reach a private, non-public service (an internal MCP server or
scanner), that connectivity is **provisioned privately** and is intentionally not
documented here. Workers/DOs reach private networks via a Cloudflare network binding
(e.g. Workers VPC / a Cloudflare Mesh network); wire the endpoint into the relevant
`MCP_*` var/secret and the `addMcpServer(...)` call. Concrete host names, IP ranges, and
the mesh wiring are part of the private runtime and are kept out of this public repo.

Docs: `developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-mesh/get-started` · `/workers-vpc/examples/connect-to-cloudflare-mesh`.

## 8. ⚠ Archived scaffold — do these BEFORE any re-migration
This repo is the superseded, never-deployed migration scaffold (see the README banner); the
live operator runs on a **private runtime provisioned separately**. The dynamic-mission
**approval gate is now correct** (a typed `waitForEvent` + one `"approval"` event carrying an
`approved` boolean — see `src/mission-template.ts` / `src/agent.ts`), but three **coupled**
prerequisites remain UNBUILT. If this CF scaffold is ever revived, land ALL THREE before
trusting a build mission end-to-end (a correct gate is moot without them):

1. **Founder notification for dynamic missions.** `onWorkflowProgress` / `onWorkflowComplete`
   never fire on the Worker-Loader path — the generated `WorkflowEntrypoint` has no Agent stub
   (verified in `agents@0.16.2`). Either wire an explicit `OperatorAgent` callback binding into
   the generated module, or move missions onto the GA `this.runWorkflow` + `AgentWorkflow` path
   (restores the hooks, but drops the per-mission runtime-generated code the dynamic path exists for).
2. **Set `SLACK_BRIEF_CHANNEL`.** It is empty, so the daily brief AND every mission
   progress/complete post are silently dropped.
3. **Pin `CHAT_MODEL` to a tool-calling-capable model.** `@cf/openai/gpt-oss-120b` currently
   returns 400 on ANY tools-array request via the AI Gateway, so the `start_mission` tool call
   can't fire. Use a tool-capable model (e.g. `@cf/nvidia/nemotron-3-120b-a12b`) or re-test
   gpt-oss tool-calling before relying on missions.

## Non-negotiables
No raw secret in repo/Slack/logs. The operator proposes; deploy/money/reveal/external-post
are founder-gated behind the Workflow approval. The treasury signing key never enters this runtime.
