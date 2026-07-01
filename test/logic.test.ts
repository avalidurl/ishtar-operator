import { describe, expect, it } from "vitest";
import { classifyTurn, computeOverBudget, isToolAllowed, parseBearer, TOOL_ALLOWLIST } from "../src/logic";

describe("tool allowlist — the enforced 'propose, don't act' gate", () => {
  it("allows only the operator's own tools", () => {
    expect(isToolAllowed("start_mission")).toBe(true);
    expect(TOOL_ALLOWLIST.has("start_mission")).toBe(true);
  });

  it("blocks Think's auto-merged workspace + shell tools", () => {
    for (const t of ["bash", "write", "edit", "delete", "read", "list", "find", "grep"]) {
      expect(isToolAllowed(t)).toBe(false);
    }
  });

  it("denies empty / unknown / undefined names (fail closed)", () => {
    expect(isToolAllowed("")).toBe(false);
    expect(isToolAllowed(undefined)).toBe(false);
    expect(isToolAllowed("mcp__notion__create_page")).toBe(false);
  });
});

describe("complexity router (classifyTurn)", () => {
  const light = "@cf/openai/gpt-oss-20b";

  it("is OFF when no light model is configured (brain answers)", () => {
    expect(classifyTurn("hi", "")).toBeUndefined();
    expect(classifyTurn("hi", undefined)).toBeUndefined();
  });

  it("routes trivial greetings/acks to the light tier", () => {
    expect(classifyTurn("hi", light)).toBe(light);
    expect(classifyTurn("thanks!", light)).toBe(light);
    expect(classifyTurn("are you there?", light)).toBe(light);
  });

  it("keeps commands/questions on the brain even when short", () => {
    expect(classifyTurn("status", light)).toBeUndefined();
    expect(classifyTurn("deploy it", light)).toBeUndefined();
    expect(classifyTurn("what is the plan", light)).toBeUndefined();
    expect(classifyTurn("summarize the venue cohort for me please", light)).toBeUndefined();
  });
});

describe("budget predicate (computeOverBudget) — fail closed", () => {
  it("treats missing/NaN/<=0 cap as over budget", () => {
    expect(computeOverBudget(Number.NaN, 0)).toBe(true);
    expect(computeOverBudget(0, 0)).toBe(true);
    expect(computeOverBudget(-5, 0)).toBe(true);
  });

  it("compares spend to a valid cap", () => {
    expect(computeOverBudget(20, 0)).toBe(false);
    expect(computeOverBudget(20, 19.99)).toBe(false);
    expect(computeOverBudget(20, 20)).toBe(true);
    expect(computeOverBudget(20, 21)).toBe(true);
  });
});

describe("parseBearer", () => {
  it("extracts the token, case-insensitive scheme, trims", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer  abc123  ")).toBe("abc123");
  });

  it("returns '' for non-bearer / missing headers", () => {
    expect(parseBearer(undefined)).toBe("");
    expect(parseBearer(null)).toBe("");
    expect(parseBearer("Basic xyz")).toBe("");
    expect(parseBearer("")).toBe("");
  });
});
