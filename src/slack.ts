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

/** Belt-and-braces: never let a key/token/seed shape leave in an outbound reply. */
export function scrubSecrets(s: string): string {
  return String(s)
    .replace(/xox[abprs]-[A-Za-z0-9-]{8,}/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[redacted]")
    .replace(/\btskey-[A-Za-z0-9-]{8,}\b/g, "[redacted]")
    .replace(/\b[A-Fa-f0-9]{64}\b/g, "[redacted]");
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
    });
    return ((await r.json().catch(() => ({}))) as { ok?: boolean }).ok === true;
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
