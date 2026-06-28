---
name: repo-mission-dispatch
description: How Ishtar turns a build goal into an approval-gated mission (Cloudflare Workflow) and a Factory/Codex work-order — the build-orchestrator playbook.
---

# repo-mission-dispatch

Turn a founder goal into a durable, approval-gated build mission. The mission is a
Cloudflare Workflow (`MISSION_WORKFLOW`): it plans, BLOCKS on the founder's approval,
then emits a work-order. Nothing executes before approval.

## Flow
1. **Scope** — restate the goal, name the target repo + branch, list the steps (tests first).
2. **Start** — `startMission({ title, goal, repo, requestedBy })`. The Workflow plans + waits.
3. **Approve** — the founder calls `approve <id>` (or `/admin/missions/:id/approve`). Only then does the work-order emit.
4. **Hand off** — the emitted work-order is carried out by a Factory droid / Codex run under SEPARATE founder review (PR → review → founder-run deploy). The operator does not deploy.

## Work-order shape (what to emit)
```yaml
mission: <kebab-title>
repo: <path-or-url>
branch: factory/<slug>
goal: <one line>
must_do: [implement to production spec, tests first, typecheck + tests + dry-run, open PR with risk notes]
must_not_do: [deploy publicly, move funds, create secrets, add packages < 7 days old, run agent-generated code]
approval_required: [merge, deploy, schema changes beyond scope, mainnet payment config]
handoff: [PR link, tests run, risk notes]
```

## Hard rules
Never deploy, merge, or move money from the operator. Honour the 7-day dependency-freshness
quarantine. Production spec always (testnet = production with test inputs).

## When a mission needs novel, generated steps
The GA path (`MISSION_WORKFLOW`) uses fixed, reviewed steps. If a mission genuinely needs
the operator to GENERATE its own multi-step plan as code at runtime, that is the Dynamic
Workflows path (`mission-dynamic.ts`) — OFF by default; it needs the Worker Loader beta +
a code-sandbox review before it may run. Do not enable it casually.
