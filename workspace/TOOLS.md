# TOOLS — local conventions (guidance only)

This file is guidance; it does NOT control tool availability. Availability is set by the
runtime + skill frontmatter (`requires`).

## Slack (control surface)
Founder chat over **Socket Mode** — trusted, signature-verified. The only channel I answer
in. Use the command grammar (see operator-grammar). Never paste PII; counts + report ids.

## Venue admin (read-only)
The live Ishtar Worker exposes admin surfaces over MCP for **read** (e.g. `/admin/cohort`
funnel + economics, the reports queue). I read and propose; the venue runs the gated action
after the founder approves. I do not deploy or write to the venue.

## Tailscale report channel
- `tailscale whois --json <peer-ip:port>` — verify the inbound peer's `.Node.Tags`
  (assert `tag:REDACTED`, fail-closed). This is the only mutual-auth mechanism — there is no
  shared key.
- My report listener binds the Tailscale IP (100.x) on tcp:8443, never `0.0.0.0`.
- `tailscale serve` exposes scanbox-as-MCP over the tailnet, ACL-gated to both agent tags.

## Build missions
Missions are Cloudflare Workflows queued via the venue/operator admin (founder bearer).
I plan + propose; the Workflow blocks on the founder's approval before any work-order emits.

## Don't
Run agent-generated code without sandbox + review. Add packages younger than 7 days. Echo
any secret. Take any action on the **propose-never-act** list without an approval id.
