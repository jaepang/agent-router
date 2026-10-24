import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_STALE_USED_MARGIN,
  createClaudeStatuslineCollector,
} from "../../src/collectors/anthropic/claude-statusline-collector.js";
import { evaluateEligibility } from "../../src/policy/eligibility.js";
import { primaryQuota } from "../../src/policy/primary-quota.js";
import { claudeModel, codexPersonal, shared, usageFor } from "../cli/fixtures.js";

const nowMs = Date.parse("2026-09-17T10:00:00.000Z");
const nowSec = nowMs / 1000;

function cacheFile(contents: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-quota-"));
  const file = path.join(dir, "statusline-quota-cache.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

function collect(cachePath: string) {
  return createClaudeStatuslineCollector({ cachePath, now: () => nowMs }).collectUsage(shared);
}

describe("claude status line quota collector", () => {
  it("reads five-hour and weekly limits with reset times", async () => {
    const snapshot = await collect(
      cacheFile({
        at: nowSec - 60,
        five_hour: { used_percentage: 22, resets_at: nowSec + 2 * 3600 },
        seven_day: { used_percentage: 40, resets_at: nowSec + 5 * 86400 },
      }),
    );
    expect(snapshot).toMatchObject({
      accountId: shared.id,
      source: "local-session",
      certainty: "estimated",
      collectedAt: new Date((nowSec - 60) * 1000).toISOString(),
    });
    expect(snapshot.windows).toEqual([
      {
        kind: "five-hour",
        remainingRatio: 0.78,
        usedRatio: 0.22,
        resetsAt: new Date((nowSec + 2 * 3600) * 1000).toISOString(),
      },
      {
        kind: "weekly",
        remainingRatio: 0.6,
        usedRatio: 0.4,
        resetsAt: new Date((nowSec + 5 * 86400) * 1000).toISOString(),
      },
    ]);
    expect(Date.parse(snapshot.expiresAt)).toBeGreaterThan(nowMs);
    expect(snapshot.stalePreserved).toBeUndefined();
  });

  it("preserves a stale exact cache conservatively until its earliest reset", async () => {
    const fiveHourReset = nowSec + 2 * 3600;
    const weeklyReset = nowSec + 5 * 86400;
    const snapshot = await collect(
      cacheFile({
        at: nowSec - 31 * 60,
        certainty: "exact",
        five_hour: { used_percentage: 22, resets_at: fiveHourReset },
        seven_day: { used_percentage: 40, resets_at: weeklyReset },
      }),
    );

    expect(CLAUDE_STALE_USED_MARGIN).toBe(0.1);
    expect(snapshot).toMatchObject({ certainty: "estimated", stalePreserved: true });
    expect(snapshot.windows).toMatchObject([
      { kind: "five-hour", usedRatio: 0.32, remainingRatio: 0.68 },
      { kind: "weekly", usedRatio: 0.5, remainingRatio: 0.5 },
    ]);
    expect(snapshot.expiresAt).toBe(new Date(fiveHourReset * 1000).toISOString());
  });

  it("does not invent recovery after a reset without a new observation", async () => {
    const snapshot = await collect(
      cacheFile({
        at: nowSec - 600,
        five_hour: { used_percentage: 95, resets_at: nowSec - 30 },
        seven_day: { used_percentage: 40, resets_at: nowSec + 86400 },
      }),
    );
    expect(snapshot.windows[0]).toMatchObject({
      kind: "five-hour",
      remainingRatio: 0.05,
      usedRatio: 0.95,
    });
  });

  it("keeps only the windows present in the cache", async () => {
    const snapshot = await collect(
      cacheFile({ at: nowSec, seven_day: { used_percentage: 10, resets_at: nowSec + 86400 } }),
    );
    expect(snapshot.windows.map((window) => window.kind)).toEqual(["weekly"]);
  });

  it.each([
    ["the cache file is missing", () => path.join(os.tmpdir(), "missing-claude-quota.json")],
    ["the cache is not JSON", () => cacheFile("not json")],
    ["the cache has no limit windows", () => cacheFile({ at: nowSec })],
    [
      "the cache is older than 30 minutes",
      () =>
        cacheFile({
          at: nowSec - 31 * 60,
          seven_day: { used_percentage: 10, resets_at: nowSec + 86400 },
        }),
    ],
    [
      "the stale exact cache has a five-hour reset in the past",
      () =>
        cacheFile({
          at: nowSec - 31 * 60,
          certainty: "exact",
          five_hour: { used_percentage: 10, resets_at: nowSec - 1 },
          seven_day: { used_percentage: 10, resets_at: nowSec + 86400 },
        }),
    ],
    [
      "the stale exact cache has a weekly reset in the past",
      () =>
        cacheFile({
          at: nowSec - 31 * 60,
          certainty: "exact",
          five_hour: { used_percentage: 10, resets_at: nowSec + 3600 },
          seven_day: { used_percentage: 10, resets_at: nowSec - 1 },
        }),
    ],
    [
      "the stale cache is not explicitly exact",
      () =>
        cacheFile({
          at: nowSec - 31 * 60,
          certainty: "estimated",
          five_hour: { used_percentage: 10, resets_at: nowSec + 3600 },
          seven_day: { used_percentage: 10, resets_at: nowSec + 86400 },
        }),
    ],
    [
      "the stale cache has no certainty",
      () =>
        cacheFile({
          at: nowSec - 31 * 60,
          five_hour: { used_percentage: 10, resets_at: nowSec + 3600 },
          seven_day: { used_percentage: 10, resets_at: nowSec + 86400 },
        }),
    ],
    [
      "the stale exact cache is missing a reset time",
      () =>
        cacheFile({
          at: nowSec - 31 * 60,
          certainty: "exact",
          five_hour: { used_percentage: 10 },
          seven_day: { used_percentage: 10, resets_at: nowSec + 86400 },
        }),
    ],
  ])("returns unknown usage when %s", async (_label, makePath) => {
    const snapshot = await collect(makePath());
    expect(snapshot.certainty).toBe("unknown");
    expect(snapshot.windows.every((window) => window.remainingRatio === undefined)).toBe(true);
  });

  it("keeps preserved Claude usage eligible without opening Cursor", async () => {
    const snapshot = await collect(
      cacheFile({
        at: nowSec - 31 * 60,
        certainty: "exact",
        five_hour: { used_percentage: 20, resets_at: nowSec + 3600 },
        seven_day: { used_percentage: 40, resets_at: nowSec + 86400 },
      }),
    );
    const policyNow = new Date(nowMs);
    expect(
      evaluateEligibility({
        account: shared,
        model: claudeModel,
        usage: snapshot,
        estimatedCostRatio: 0,
        now: policyNow,
      }),
    ).toMatchObject({ eligible: true });
    const quota = primaryQuota(
      [codexPersonal, shared],
      {
        [codexPersonal.id]: usageFor(codexPersonal.id, 0, {
          windows: [{ kind: "weekly", remainingRatio: 0 }],
          collectedAt: policyNow.toISOString(),
          expiresAt: new Date(nowMs + 60_000).toISOString(),
        }),
        [shared.id]: snapshot,
      },
      policyNow,
    );
    expect(quota).toMatchObject({ cursorAllowed: false, status: "quota-wait" });
    expect(quota.reason).toContain("claude-code=available");
  });
});
