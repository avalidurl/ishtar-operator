import { describe, expect, it } from "vitest";
import { generateMissionModule } from "../src/mission-template";
import { scrubSecrets, timingSafeEqual, verifySlackSignature } from "../src/slack";

const enc = new TextEncoder();

/** Produce a valid Slack signature for a body+timestamp, the way Slack does. */
async function sign(secret: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

describe("Slack signature verification (the /slack edge gate)", () => {
  const secret = "test-signing-secret";
  const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });

  it("accepts a correctly-signed, fresh request", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign(secret, ts, body);
    expect(await verifySlackSignature(secret, ts, body, sig)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign(secret, ts, body);
    expect(await verifySlackSignature(secret, ts, body + "X", sig)).toBe(false);
  });

  it("rejects a stale timestamp (replay window > 5 min)", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const sig = await sign(secret, ts, body);
    expect(await verifySlackSignature(secret, ts, body, sig)).toBe(false);
  });

  it("fails closed on missing inputs", async () => {
    expect(await verifySlackSignature(undefined, "1", body, "v0=x")).toBe(false);
    expect(await verifySlackSignature(secret, null, body, "v0=x")).toBe(false);
    expect(await verifySlackSignature(secret, "1", body, null)).toBe(false);
  });
});

describe("constant-time compare + secret scrub", () => {
  it("timingSafeEqual matches only on equality", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("scrubSecrets redacts token shapes", () => {
    expect(scrubSecrets("here is xoxb-123456789-abcdefghij")).toContain("[redacted]");
    expect(scrubSecrets("key sk-abcdefghijklmnopqrstuvwx")).toContain("[redacted]");
    expect(scrubSecrets("nothing to see")).toBe("nothing to see");
  });
});

describe("dynamic mission approval gate (regression — typeless waitForEvent broke approve/reject)", () => {
  const mod = generateMissionModule({ title: "ship it", goal: "do the thing", requestedBy: "founder" });

  it("waits on a TYPED approval event — CF matches sendEvent by `type`", () => {
    // The live bug: `waitForEvent("approval", { timeout })` with NO `type`, which
    // sendEvent({ type: "approval" }) could never satisfy → 7-day hang then error.
    expect(mod).toContain('{ type: "approval", timeout: "7 days" }');
    expect(mod).not.toMatch(/waitForEvent\(\s*"approval"\s*,\s*\{\s*timeout:/); // no typeless wait
  });

  it("gates on the `approved` boolean, not on the presence of a reason", () => {
    expect(mod).toContain("payload.approved");
  });

  it("emits the work-order only past the approval gate (fails closed on timeout)", () => {
    expect(mod).toContain("approval timed out");
    // emit-work-order must come AFTER the approved check, never before the wait.
    expect(mod.indexOf("payload.approved")).toBeLessThan(mod.indexOf("emit-work-order"));
  });
});
