import { describe, expect, it, vi } from "vitest";
import { primaryQuota } from "../../src/policy/primary-quota.js";
import { executeRun } from "../../src/commands/run.js";
import { buildAgentCommand } from "../../src/launch/agent-command.js";
import { evaluateEligibility } from "../../src/policy/eligibility.js";
import {
  codexPersonal,
  codexModel,
  shared,
  claudeModel,
  personal,
  cursorModel,
  usageFor,
  fakeTypeSafe,
  now,
} from "../cli/fixtures.js";
import type { UsageSnapshot } from "../../src/domain/usage.js";

const weekly = (id: string, remaining = 0) =>
  usageFor(id, remaining, { windows: [{ kind: "weekly", remainingRatio: remaining }] });
const short = (id: string, reset: string) =>
  usageFor(id, 0, {
    windows: [
      { kind: "five-hour", remainingRatio: 0, resetsAt: reset },
      { kind: "weekly", remainingRatio: 0.8 },
    ],
  });
const accounts = [codexPersonal, shared, personal];
const models = [cursorModel, codexModel, claudeModel];
function run(usage: Record<string, UsageSnapshot>) {
  const client = fakeTypeSafe({ route: `${personal.id}:${cursorModel.id}` });
  return {
    client,
    result: executeRun("Implement the approved plan.", { dryRun: true }, {
      accounts,
      models,
      usage,
      client,
      env: {},
      now,
    } as Parameters<typeof executeRun>[2]),
  };
}

describe("primary quota routing policy", () => {
  it("chooses Codex with 100% weekly remaining even if Cursor is ranked first and Claude is unknown", async () => {
    const { result } = run({
      [codexPersonal.id]: weekly(codexPersonal.id, 1),
      [personal.id]: weekly(personal.id, 1),
    });
    expect((await result).json).toMatchObject({ selected: `${codexPersonal.id}:${codexModel.id}` });
  });
  it("chooses Claude when Codex usage is unknown", async () => {
    const { result } = run({
      [shared.id]: weekly(shared.id, 0.9),
      [personal.id]: weekly(personal.id, 1),
    });
    expect((await result).json).toMatchObject({ selected: `${shared.id}:${claudeModel.id}` });
  });
  it("waits for the earliest short-term reset without ranking or launching Cursor", async () => {
    const usage = {
      [codexPersonal.id]: short(codexPersonal.id, "2026-09-17T12:00:00.000Z"),
      [shared.id]: short(shared.id, "2026-09-17T11:00:00.000Z"),
      [personal.id]: weekly(personal.id, 1),
    };
    const { result, client } = run(usage);
    expect(await result).toMatchObject({
      code: 75,
      json: { status: "quota-wait", retryAt: "2026-09-17T11:00:00.000Z" },
    });
    expect(client.calls).toEqual([]);
  });
  it("opens Cursor only on both weekly limits", async () => {
    const { result } = run({
      [codexPersonal.id]: weekly(codexPersonal.id),
      [shared.id]: weekly(shared.id),
      [personal.id]: weekly(personal.id, 1),
    });
    expect((await result).json).toMatchObject({ selected: `${personal.id}:${cursorModel.id}` });
  });
  it("does not open Cursor from a preserved Claude weekly value exhausted only by its margin", () => {
    const preservedClaude = usageFor(shared.id, 0.0001, {
      certainty: "estimated",
      stalePreserved: true,
      windows: [
        { kind: "five-hour", remainingRatio: 0.0001 },
        { kind: "weekly", remainingRatio: 0.0001 },
      ],
      collectedAt: new Date(now.getTime() - 31 * 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const quota = primaryQuota(
      [codexPersonal, shared],
      { [codexPersonal.id]: weekly(codexPersonal.id), [shared.id]: preservedClaude },
      now,
    );
    expect(quota.cursorAllowed).toBe(false);
    expect(quota.status).toBe("usage-unavailable");
  });
  it.each([
    undefined,
    usageFor(shared.id, 0.8, { certainty: "unknown" }),
    usageFor(shared.id, 0.8, {
      collectedAt: "2026-09-17T08:00:00.000Z",
      expiresAt: "2026-09-18T08:00:00.000Z",
    }),
  ])("blocks unknown/stale primary usage even with fresh Cursor usage", async (claude) => {
    const usage = {
      [codexPersonal.id]: weekly(codexPersonal.id),
      [personal.id]: weekly(personal.id, 1),
      ...(claude ? { [shared.id]: claude } : {}),
    };
    const { result, client } = run(usage);
    expect(await result).toMatchObject({ code: 75, json: { status: "usage-unavailable" } });
    expect(client.calls).toEqual([]);
  });
  it("cannot unlock Cursor when a primary CLI is missing or disabled", () => {
    expect(
      primaryQuota([personal], { [personal.id]: weekly(personal.id, 1) }, now).cursorAllowed,
    ).toBe(false);
  });
  it("rechecks observation age after ranking before reserving or launching", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const client = fakeTypeSafe({});
      const original = client.systemOne.bind(client);
      client.systemOne = async (request) => {
        const answer = await original(request);
        if ("route" in request.questions) vi.setSystemTime(new Date(now.getTime() + 3600_000));
        return answer;
      };
      const result = await executeRun(
        "Implement the approved plan.",
        { dryRun: true },
        {
          accounts: [codexPersonal],
          models: [codexModel],
          usage: { [codexPersonal.id]: weekly(codexPersonal.id, 1) },
          client,
          env: {},
        },
      );
      expect(result).toMatchObject({
        code: 75,
        json: { status: "usage-unavailable", reason: "stale-usage" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("uses the configured maximum age for personal accounts even with a later expiresAt", () => {
    const input = {
      account: codexPersonal,
      model: codexModel,
      usage: usageFor(codexPersonal.id, 1, {
        collectedAt: "2026-09-17T08:50:00.000Z",
        expiresAt: "2026-09-18T09:00:00.000Z",
      }),
      now,
      estimatedCostRatio: 0,
    };
    expect(evaluateEligibility({ ...input, usageMaxAgeMs: 600_000 })).toMatchObject({
      eligible: false,
      reason: "stale-usage",
    });
    expect(evaluateEligibility({ ...input, usageMaxAgeMs: 1200_000 })).toMatchObject({
      eligible: true,
    });
  });
});

describe("Cursor model family guard", () => {
  it.each(["claude-opus-5-5", "GPT-5", "gemini-3", "cursor-Claude-opus-high"])(
    "refuses %s before a Cursor command can be created",
    (launchName) => {
      expect(() => buildAgentCommand({ agent: "cursor", launchName, effort: "high" })).toThrow(
        /Cursor model refused/,
      );
    },
  );
  it.each(["grok-4.6", "auto", "composer-2.5"])("preserves %s", (launchName) => {
    expect(buildAgentCommand({ agent: "cursor", launchName, effort: "none" })).toEqual([
      "agent",
      "--model",
      launchName,
    ]);
  });
});

describe("review round 1 regressions", () => {
  const unknown = (id: string) => usageFor(id, 0, { certainty: "unknown" });
  const openModel = {
    ...codexModel,
    id: "opencode:review-model",
    agent: "opencode" as const,
    provider: "opencode" as const,
    launchName: "review-model",
  };
  const openAccount = {
    ...codexPersonal,
    id: "acct_opencode",
    agent: "opencode" as const,
    provider: "opencode" as const,
    enabledModels: [openModel.id],
  };

  it("refuses a Cursor model attached to a Codex account with fresh remaining quota", async () => {
    const mismatched = { ...codexPersonal, enabledModels: [cursorModel.id] };
    const client = fakeTypeSafe({});
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true, noEnrich: true },
      {
        accounts: [mismatched, shared, personal],
        models: [cursorModel, claudeModel],
        usage: {
          [mismatched.id]: weekly(mismatched.id, 0.8),
          [shared.id]: unknown(shared.id),
          [personal.id]: unknown(personal.id),
        },
        client,
        env: {},
        now,
      },
    );
    expect(result).toMatchObject({
      code: 75,
      json: {
        ok: false,
        exclusions: expect.arrayContaining([
          { accountId: mismatched.id, modelId: cursorModel.id, reason: "account-agent-mismatch" },
        ]),
      },
    });
    expect(client.calls).toEqual([]);
    expect(
      evaluateEligibility({
        account: mismatched,
        model: cursorModel,
        usage: weekly(mismatched.id, 0.8),
        estimatedCostRatio: 0,
        now,
      }),
    ).toEqual({ eligible: false, reason: "account-agent-mismatch" });
  });

  it("refuses a primary model attached to an account for another CLI", () => {
    const mismatched = { ...personal, enabledModels: [codexModel.id] };
    expect(
      evaluateEligibility({
        account: mismatched,
        model: codexModel,
        usage: weekly(mismatched.id, 0.8),
        estimatedCostRatio: 0,
        now,
      }),
    ).toEqual({ eligible: false, reason: "account-agent-mismatch" });
  });

  it.each(["unknown", "short-term"])(
    "cannot route through OpenCode when both primary CLIs are %s",
    async (state) => {
      const blocked =
        state === "unknown"
          ? unknown
          : (id: string) =>
              short(id, id === shared.id ? "2026-09-17T11:00:00.000Z" : "2026-09-17T12:00:00.000Z");
      const client = fakeTypeSafe({ route: `${openAccount.id}:${openModel.id}` });
      const result = await executeRun(
        "Implement the approved plan.",
        { dryRun: true, noEnrich: true },
        {
          accounts: [codexPersonal, shared, openAccount],
          models: [codexModel, claudeModel, openModel],
          usage: {
            [codexPersonal.id]: blocked(codexPersonal.id),
            [shared.id]: blocked(shared.id),
            [openAccount.id]: weekly(openAccount.id, 0.8),
          },
          client,
          env: {},
          now,
        },
      );
      expect(result).toMatchObject({
        code: 75,
        json: {
          ok: false,
          status: state === "unknown" ? "usage-unavailable" : "quota-wait",
          ...(state === "short-term" ? { retryAt: "2026-09-17T11:00:00.000Z" } : {}),
        },
      });
      expect(client.calls).toEqual([]);
    },
  );

  it("keeps a usable Codex ahead of a fresh OpenCode candidate", async () => {
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true, noEnrich: true },
      {
        accounts: [codexPersonal, shared, openAccount],
        models: [openModel, codexModel, claudeModel],
        usage: {
          [codexPersonal.id]: weekly(codexPersonal.id, 0.8),
          [shared.id]: unknown(shared.id),
          [openAccount.id]: weekly(openAccount.id, 1),
        },
        client: fakeTypeSafe({ route: `${openAccount.id}:${openModel.id}` }),
        env: {},
        now,
      },
    );
    expect(result).toMatchObject({
      code: 0,
      json: { selected: `${codexPersonal.id}:${codexModel.id}` },
    });
  });

  it("permits a known fallback only after both primary weekly limits", async () => {
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: true, noEnrich: true },
      {
        accounts: [codexPersonal, shared, openAccount],
        models: [openModel, codexModel, claudeModel],
        usage: {
          [codexPersonal.id]: weekly(codexPersonal.id),
          [shared.id]: weekly(shared.id),
          [openAccount.id]: weekly(openAccount.id, 0.8),
        },
        client: fakeTypeSafe({}),
        env: {},
        now,
      },
    );
    expect(result).toMatchObject({
      code: 0,
      json: { selected: `${openAccount.id}:${openModel.id}` },
    });
  });
});
