#!/usr/bin/env node
// Writes ~/.cursor/statusline-quota-cache.json from Cursor GetCurrentPeriodUsage.
// planUsage.apiPercentUsed and autoPercentUsed are USED percents.
// pct / auto_left are remaining percents. Never invents a missing field.
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

export function clampRemaining(usedPercent) {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function cacheFromPlanUsage(body, nowSec = Math.floor(Date.now() / 1000)) {
  const plan = body?.planUsage;
  const api = plan?.apiPercentUsed;
  const auto = plan?.autoPercentUsed;
  if (typeof api !== "number" || !Number.isFinite(api)) return undefined;
  if (typeof auto !== "number" || !Number.isFinite(auto)) return undefined;
  return { pct: clampRemaining(api), auto_left: clampRemaining(auto), at: nowSec };
}

export function redactToken(message, token) {
  if (!token || !message) return message;
  return message.split(token).join("[REDACTED]");
}

export async function refreshCursorQuota({
  accessToken,
  cachePath,
  fetchImpl = fetch,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  const response = await fetchImpl(USAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`cursor usage HTTP ${response.status}`);
  }
  const body = await response.json();
  const cache = cacheFromPlanUsage(body, nowSec);
  if (!cache) {
    throw new Error("cursor usage response missing plan percents");
  }
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  return cache;
}

async function main() {
  const cachePath =
    process.env.CURSOR_QUOTA_CACHE_PATH ??
    path.join(os.homedir(), ".cursor", "statusline-quota-cache.json");
  let token;
  try {
    token = process.env.CURSOR_USAGE_ACCESS_TOKEN;
    if (!token)
      throw new Error("cursor usage unavailable: no supplied access token; login disabled");
    const cache = await refreshCursorQuota({ accessToken: token, cachePath });
    process.stdout.write(`cursor quota pct=${cache.pct} auto_left=${cache.auto_left}\n`);
  } catch (error) {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      `${JSON.stringify({ at: Math.floor(Date.now() / 1000), certainty: "unknown", error: "usage_refresh_failed" })}\n`,
      { mode: 0o600 },
    );
    const message = error instanceof Error ? error.message : "cursor quota refresh failed";
    process.stderr.write(`${redactToken(message, token)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
