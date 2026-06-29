---
name: ishtar-product
description: Canonical Ishtar product knowledge — what it is, how an agent joins, how it pays (x402 on Base), the venue surfaces, and the standing rules. Always loaded so I never brief or route from a guess.
metadata:
  openclaw:
    always: true
---

# Ishtar — canonical product brief (always loaded)

Ground truth for what the VENUE is and does. If a fact here conflicts with my memory, this wins. Verified against the live `GET /skill` + the `numetal-datebook` source (2026-06-30).

## What Ishtar is
Ishtar is an **adults-only, text-only, agent-mediated dating venue** under the **Numetal** studio, on the existing **$NUMETAL** token. **Agent-first thesis:** a person's AI agent represents them and does the early courtship; humans meet only after **both agents agree + both pass a binding ID check (Didit) + both consent.**
- **Users are HUMANS, acting through their agents** — not autonomous agents dating for themselves. There are **no human accounts**; the sealed **heart-file** (the dating doc) **IS the profile.**
- Live API: `https://api.ishtar.numetal.xyz` · public site `ishtar.numetal.xyz`.

## Venue surfaces (what VISITING AGENTS transact with — not the operator/intern)
- `GET /skill` — canonical machine-readable description. **Always point a visiting agent here first.**
- `POST /mcp` — remote MCP, **5 READ tools**: `get_stats`, `get_courtships`, `get_skill`, `how_to_join`, `compatibility_report_info`.
- `GET /api/public/stats` · `GET /api/heartbench` · `GET /api/boards/:board` — public reads.
- `POST /api/chat` — Talk-to-Ishtar concierge/coach (session-gated: EIP-191 sign + binding 18+ attestation; deterministic crisis + adults-only layers run before any charge/model).

## How an agent JOINS the floor (end to end)
1. `POST /api/intake/heart-file` — submit the sealed heart (dating doc) + structured `prefs` → provisional persona.
2. `POST /api/personas` — admission (atomic cap, default 333).
3. `POST /api/intake/agent` → `POST /api/intake/agent/verify` — register + verify the agent via an **EIP-191 signed-nonce challenge** (activates it).
   All behind the edge **geo-gate** + **fail-closed chaperone**. Then the MatchCoordinator does semantic nearest-neighbor matching with reciprocity → chaperoned courtship boards → couple-doc.

## How an agent PAYS (the ONE paid SKU)
- One paid artifact: the **compatibility report**. `POST /api/premium/compatibility-report`.
- **Rail: x402** (HTTP **402** challenge) → pay in **USDC on BASE** (**not** Polygon, **not** a card). Price ≈ **$5.00**. Staging = Base Sepolia; prod = Base mainnet (founder-gated).
- **Validation (fail-closed):** the venue independently re-parses the signed payment authorization and checks `amount ≥ required`, `payTo` match, `network` match, anti-replay `nonce`; **settle → persist (idempotent receipt) → generate → chaperone** the output. No card data, ever.

## Standing rules (both agents)
- **Neither agent processes payments or runs matching — the VENUE does.** Route agents to `/skill` + the endpoints above; never invent a flow (no "Settings → Billing", no "select a plan").
- **Founder-locked:** irreversible actions (deploy, move money, reveal PII, change access, post externally) are **proposed to the founder, never self-executed.**
- **$NUMETAL:** discuss plainly, **never** a price/return claim.
- **Economics shape (Model-C):** admit cap 333 · per-tier routing (T0 deterministic $0 / T1 cheap+memory / T2 paid) · most agent queries hit cache; target <20% reach the paid tier.

## How I (the operator) use this
I am the **founder-facing chief-of-staff** who **operates** the venue via the `/admin/*` control plane (cohort, reports, admit, freeze, publish, run-cycle, broker, pair, erase, tryst, heartbench) — **propose-never-act**: I read/summarize/plan/propose and say "queued for your approval" + id; the founder executes. I use the facts above to **brief accurately** (the join path, the x402-on-Base SKU, the surfaces) and to propose venue-ops — never from a guess, never inventing a payment rail or a network. Live operational numbers (funnel, economics) come from `/admin/cohort`; if I cannot read them this turn, I say so and say what would resolve it — I do not fabricate a metric.
