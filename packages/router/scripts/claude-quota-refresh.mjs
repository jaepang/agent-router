#!/usr/bin/env node
// Writes ~/.claude/statusline-quota-cache.json from GET /api/oauth/usage.
// five_hour.utilization and seven_day.utilization are USED percents. A window is
// written only when utilization is a finite number. Never invents a window.
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export function redactToken(message, token) {
  if (!token || !message) return message;
  return message.split(token).join("[REDACTED]");
}

function windowFrom(raw) {
  if (!raw || typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization)) {
    return undefined;
  }
  const entry = { used_percentage: raw.utilization };
  if (typeof raw.resets_at === "string") {
    const ms = Date.parse(raw.resets_at);
    if (Number.isFinite(ms)) entry.resets_at = Math.floor(ms / 1000);
  }
  return entry;
}

export function cacheFromOauthUsage(body, nowSec = Math.floor(Date.now() / 1000)) {
  const fiveHour = windowFrom(body?.five_hour);
  const sevenDay = windowFrom(body?.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return {
    at: nowSec,
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(sevenDay ? { seven_day: sevenDay } : {}),
  };
}

export async function refreshClaudeQuota({
  accessToken,
  cachePath,
  fetchImpl = fetch,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  const response = await fetchImpl(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!response.ok) {
    throw new Error(`claude usage HTTP ${response.status}`);
  }
  const body = await response.json();
  const cache = cacheFromOauthUsage(body, nowSec);
  if (!cache) {
    throw new Error("claude usage response missing utilization");
  }
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  return cache;
}

function summary(cache) {
  const parts = ["claude quota"];
  if (cache.five_hour) parts.push(`five_hour_used=${cache.five_hour.used_percentage}`);
  if (cache.seven_day) parts.push(`seven_day_used=${cache.seven_day.used_percentage}`);
  return parts.join(" ");
}

async function main() {
  const cachePath =
    process.env.CLAUDE_QUOTA_CACHE_PATH ??
    path.join(os.homedir(), ".claude", "statusline-quota-cache.json");
  let token;
  try {
    token = process.env.CLAUDE_USAGE_ACCESS_TOKEN;
    if (!token)
      throw new Error("claude usage unavailable: no supplied access token; login disabled");
    const cache = await refreshClaudeQuota({ accessToken: token, cachePath });
    process.stdout.write(`${summary(cache)}\n`);
  } catch (error) {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      `${JSON.stringify({ at: Math.floor(Date.now() / 1000), certainty: "unknown", error: "usage_refresh_failed" })}\n`,
      { mode: 0o600 },
    );
    const message = error instanceof Error ? error.message : "claude quota refresh failed";
    process.stderr.write(`${redactToken(message, token)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
