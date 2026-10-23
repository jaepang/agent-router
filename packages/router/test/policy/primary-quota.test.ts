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
