/**
 * slack.ts — Slack HTTP Events API helpers (the Cloudflare-native path).
 *
 * Workers cannot hold a Socket-Mode websocket client, so the operator uses the
 * HTTP Events API: Slack POSTs to /slack, we verify the signing-secret HMAC,
 * route by team_id to the per-workspace OperatorAgent DO, run a turn, and reply
 * via the Slack Web API. Signature-verify + scrub are ported from the verified,
 * adversarially-tested ishtar-intern implementation.
 */

const enc = new TextEncoder();

/** Constant-time compare (no early-exit length/prefix oracle). */
export function timingSafeEqual(a: string, b: string): boolean {
  const A = enc.encode(a);
  const B = enc.encode(b);
  let diff = A.length ^ B.length;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) diff |= (A[i] ?? 0) ^ (B[i] ?? 0);
  return diff === 0;
}

/**
 * Verify a Slack request signature: HMAC-SHA256 over `v0:{ts}:{rawBody}` keyed
 * by the signing secret, with a 5-minute replay window. Returns false fast on
 * any missing input (fail closed).
 */
export async function verifySlackSignature(
  signingSecret: string | undefined,
  timestamp: string | undefined | null,
  rawBody: string,
  signature: string | undefined | null,
): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature) return false;
  const t = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(t)) return false;
  // 5-minute replay window (Slack's recommendation).
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(`v0=${hex}`, signature);
}

/**
 * Belt-and-braces: never let a known token/key shape leave in an outbound reply. This is
 * defense-in-depth on the model's reply — the founder secrets (ACCESS_KEY / SLACK_SIGNING_SECRET
 * / MCP_TOKEN / SLACK_BOT_TOKEN) are never placed in the model's context, but MCP tool
 * results the model can echo may carry tokens, so breadth matters.
 *
 * Deliberately does NOT redact bare 64-hex strings: that pattern matches sha256 content
 * hashes / tx hashes the operator legitimately reports, and no scaffold secret is bare
 * 64-hex. A `Bearer <token>` is redacted instead, which covers those secrets when echoed
 * inside an Authorization header.
 */
export function scrubSecrets(s: string): string {
  return String(s)
    // Slack token family (bot/user/app-config/refresh) + app-level token.
    .replace(/\bxox[abopres]-[A-Za-z0-9-]{8,}/gi, "[redacted]")
    .replace(/\bxapp-[A-Za-z0-9-]{8,}/gi, "[redacted]")
    // OpenAI-style, Tailscale, GitHub, AWS access-key shapes.
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\btskey-[A-Za-z0-9-]{8,}\b/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    // Any explicit bearer token (covers arbitrary founder-set secrets when echoed in a header).
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]");
}

/** Post a message to Slack via the Web API. Returns ok. Never throws. */
export async function slackPostMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<boolean> {
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
      // Bound the call so a hung Slack upstream can't stall the DO alarm indefinitely.
      signal: AbortSignal.timeout(5000),
    });
    return ((await r.json().catch(() => ({}))) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/**
 * Open (idempotent) a DM with a user id and post a message. Used for proactive
 * founder pings (e.g. the daily-budget warning) where we don't have a channel in
 * hand. Returns ok; never throws.
 */
export async function slackDmUser(botToken: string, userId: string, text: string): Promise<boolean> {
  try {
    const open = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ users: userId }),
      signal: AbortSignal.timeout(5000),
    });
    const ch = ((await open.json().catch(() => ({}))) as { channel?: { id?: string } }).channel?.id;
    if (!ch) return false;
    return slackPostMessage(botToken, ch, text);
  } catch {
    return false;
  }
}

/** Minimal shape of the Slack Events API envelope we consume. */
export interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  };
}
