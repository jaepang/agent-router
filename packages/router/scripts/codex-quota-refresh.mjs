#!/usr/bin/env node
// Writes ~/.codex/statusline-quota-cache.json from `codex app-server` account/rateLimits/read.
// usedPercent is converted to weekly remaining. Never invents a window.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function clampRemaining(usedPercent) {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function weeklyLeftFromRateLimits(rateLimits) {
  const windows = [rateLimits?.primary, rateLimits?.secondary].filter(
    (window) =>
      window && typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent),
  );
  if (windows.length === 0) return undefined;
  const weekly = windows.find((window) => window.windowDurationMins === 10080);
  return weekly ? clampRemaining(weekly.usedPercent) : undefined;
}

function request(id, method, params) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

export function readRateLimitsFromLines(lines) {
  for (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== 2) continue;
    if (message.error) {
      throw new Error("codex rateLimits request failed");
    }
    const result = message.result ?? {};
    return result.rateLimits ?? result.rate_limits ?? result;
  }
  throw new Error("codex rateLimits response missing");
}

export async function refreshCodexQuota({
  cachePath,
  spawnImpl = defaultSpawn,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  const child = spawnImpl();
  const lines = [];
  let buffer = "";
  let asked = false;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("codex app-server timed out"));
    }, 20_000);
    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const take = (text) => {
      buffer += text;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        lines.push(part);
        let message;
        try {
          message = JSON.parse(part);
        } catch {
          continue;
        }
        if (!asked && message.id === 1) {
          asked = true;
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
          child.stdin.write(request(2, "account/rateLimits/read", {}));
        }
        if (message.id === 2) finish();
      }
    };
    child.stdout.on("data", (chunk) => take(chunk.toString("utf8")));
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (buffer.trim()) take(`${buffer}\n`);
      if (
        !lines.some((line) => {
          try {
            return JSON.parse(line).id === 2;
          } catch {
            return false;
          }
        })
      ) {
        finish(new Error(`codex app-server exited ${code ?? "unknown"}`));
      }
    });
  });
  child.stdin.write(
    request(1, "initialize", {
      clientInfo: { name: "agent-router", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }),
  );
  try {
    await done;
  } finally {
    child.kill();
  }
  const limits = readRateLimitsFromLines(lines);
  const weeklyLeft = weeklyLeftFromRateLimits(limits);
  if (weeklyLeft === undefined) {
    throw new Error("codex rateLimits missing usedPercent");
  }
  const cache = { weekly_left: weeklyLeft, at: nowSec };
  for (const window of [limits?.primary, limits?.secondary]) {
    const key =
      window?.windowDurationMins === 300
        ? "five_hour"
        : window?.windowDurationMins === 10080
          ? "seven_day"
          : undefined;
    if (key && typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
      cache[key] = {
        used_percentage: window.usedPercent,
        ...(typeof window.resetsAt === "number" ? { resets_at: window.resetsAt } : {}),
      };
    }
  }
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  return cache;
}

function defaultSpawn() {
  const argv = process.env.CODEX_APP_SERVER_ARGV
    ? JSON.parse(process.env.CODEX_APP_SERVER_ARGV)
    : ["codex", "app-server", "--listen", "stdio://"];
  return spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
}

async function main() {
  const cachePath =
    process.env.CODEX_QUOTA_CACHE_PATH ??
    path.join(os.homedir(), ".codex", "statusline-quota-cache.json");
  try {
    const cache = await refreshCodexQuota({ cachePath });
    process.stdout.write(`codex quota weekly_left=${cache.weekly_left}\n`);
  } catch (error) {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      `${JSON.stringify({ at: Math.floor(Date.now() / 1000), certainty: "unknown", error: "usage_refresh_failed" })}\n`,
      { mode: 0o600 },
    );
    const message = error instanceof Error ? error.message : "codex quota refresh failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
