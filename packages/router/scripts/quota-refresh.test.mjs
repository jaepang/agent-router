import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheFromOauthUsage, refreshClaudeQuota } from "./claude-quota-refresh.mjs";
import { cacheFromPlanUsage, refreshCursorQuota } from "./cursor-quota-refresh.mjs";
import { weeklyLeftFromRateLimits, refreshCodexQuota } from "./codex-quota-refresh.mjs";

const cacheFile = () =>
  path.join(mkdtempSync(path.join(os.tmpdir(), "quota-refresh-")), "cache.json");

describe("quota refresh scripts", () => {
  it("never calls a five-hour Codex window a week", () => {
    expect(
      weeklyLeftFromRateLimits({ primary: { usedPercent: 2, windowDurationMins: 300 } }),
    ).toBeUndefined();
    expect(
      weeklyLeftFromRateLimits({ secondary: { usedPercent: 2, windowDurationMins: 10080 } }),
    ).toBe(98);
  });
  it("retains both Codex windows and resets from whitespace-containing RPC responses", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const messages = [];
    child.stdin = {
      write(text) {
        const message = JSON.parse(text);
        messages.push(message);
        if (message.id === 1)
          queueMicrotask(() => child.stdout.emit("data", '{"id": 1, "result": {}}\n'));
        if (message.id === 2)
          queueMicrotask(() =>
            child.stdout.emit(
              "data",
              JSON.stringify({
                id: 2,
                result: {
                  rateLimits: {
                    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2000000000 },
                    secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 2000100000 },
                  },
                },
              }) + "\n",
            ),
          );
      },
    };
    child.kill = () => true;
    const cachePath = cacheFile();
    const cache = await refreshCodexQuota({
      cachePath,
      spawnImpl: () => child,
      nowSec: 1800000000,
    });
    expect(cache).toMatchObject({
      weekly_left: 98,
      five_hour: { used_percentage: 100, resets_at: 2000000000 },
      seven_day: { used_percentage: 2, resets_at: 2000100000 },
    });
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual(cache);
    expect(messages.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
  });
  it("parses real Claude windows and does not invent missing windows", () => {
    expect(
      cacheFromOauthUsage(
        { five_hour: { utilization: 100, resets_at: "2026-10-24T01:00:00Z" } },
        1,
      ),
    ).toMatchObject({ at: 1, five_hour: { used_percentage: 100 } });
    expect(cacheFromOauthUsage({})).toBeUndefined();
  });
  it.each([401, 500])(
    "fails closed on Claude HTTP %s without storing stale usage",
    async (status) => {
      await expect(
        refreshClaudeQuota({
          accessToken: "fake",
          cachePath: cacheFile(),
          fetchImpl: async () => ({ ok: false, status }),
        }),
      ).rejects.toThrow(`HTTP ${status}`);
    },
  );
  it("keeps Cursor monthly measurements distinct from weekly included usage", () => {
    expect(cacheFromPlanUsage({ planUsage: { apiPercentUsed: 1, autoPercentUsed: 5 } }, 1)).toEqual(
      { at: 1, pct: 99, auto_left: 95 },
    );
    expect(cacheFromPlanUsage({ planUsage: { apiPercentUsed: 1 } })).toBeUndefined();
  });
  it("uses an injected Cursor fetch without running a coding agent", async () => {
    const cache = await refreshCursorQuota({
      accessToken: "fake",
      cachePath: cacheFile(),
      nowSec: 1,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ planUsage: { apiPercentUsed: 0, autoPercentUsed: 2 } }),
      }),
    });
    expect(cache).toMatchObject({ pct: 100, auto_left: 98 });
  });
});
