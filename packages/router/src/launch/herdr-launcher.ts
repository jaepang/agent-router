import { createHash, randomBytes } from "node:crypto";
import { redactCollectorText } from "../collectors/normalizer.js";
import type { AgentId } from "../domain/ids.js";
import type { ReasoningEffort } from "../domain/model-profile.js";
import { buildAgentCommand, herdrAgentKind } from "./agent-command.js";
import { createHerdrClient, type HerdrClient, type HerdrSendResult } from "./herdr-client.js";
import { isHerdrEnv } from "./readiness.js";

export function parseHerdrPaneId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const data = JSON.parse(trimmed) as {
      result?: { pane?: { pane_id?: unknown } };
      pane?: { pane_id?: unknown };
    };
    const id = data.result?.pane?.pane_id ?? data.pane?.pane_id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  } catch {
    // Fall back to the first token of plain-text Herdr output.
  }
  return trimmed.split(/\s+/)[0];
}

// Herdr reports failures as JSON ({"error":{"code":"...","message":"..."}}) on stdout or
// stderr depending on the command.
export function herdrError(result: { stdout: string; stderr: string }, action: string): string {
  for (const stream of [result.stdout, result.stderr]) {
    try {
      const data = JSON.parse(stream.trim()) as {
        error?: { code?: unknown; message?: unknown };
      };
      const code = typeof data.error?.code === "string" ? data.error.code : undefined;
      const message = typeof data.error?.message === "string" ? data.error.message : undefined;
      if (code || message) {
        return `${action}: ${[code, message].filter(Boolean).join(": ")}`;
      }
    } catch {
      // Not JSON; try the next stream.
    }
  }
  const stderr = result.stderr.trim();
  return stderr ? `${action}: ${stderr}` : action;
}

// Herdr agent names must be unique among live agents and match [a-z][a-z0-9_-]{0,31}.
// Deriving the name from the launch token keeps each launch distinct and lets a retry reuse it.
export function herdrAgentName(agent: AgentId, launchToken: string): string {
  const suffix = createHash("sha256").update(launchToken).digest("hex").slice(0, 6);
  return `router-${herdrAgentKind(agent)}-${suffix}`;
}

const HANDOFF_TIMEOUT_MS = 30_000;
/**
 * How long `herdr-send` waits for a busy agent to go idle before a follow-up. Together with
 * HANDOFF_TIMEOUT_MS this stays under the 60s process limit of the Herdr command adapter.
 */
const FOLLOW_UP_WAIT_IDLE_SEC = 15;

export interface LaunchResult {
  ok: boolean;
  error?: string;
  paneCreated?: boolean;
  printed?: string;
  launchToken?: string;
  paneId?: string;
  agentName?: string;
  /** The text reached the agent but it could not be confirmed to start; never resend. */
  sentUnconfirmed?: boolean;
}

export async function launchRoutedAgent(input: {
  env: NodeJS.Dict<string>;
  agent: AgentId;
  launchName: string;
  effort: ReasoningEffort;
  handoff: string;
  dryRun: boolean;
  existingLaunchToken?: string;
  existingPaneId?: string;
  herdr?: HerdrClient;
  /**
   * Working directory for a new pane (`herdr pane split --cwd`). Callers should always pass
   * it: omitted, Herdr starts the pane in the directory of the pane it splits, which for a
   * reused `router-anchor` workspace is whatever repository that anchor pane is in. Ignored
   * when `existingPaneId` is set.
   */
  cwd?: string;
}): Promise<LaunchResult> {
  if (!isHerdrEnv(input.env) && !input.dryRun) {
    return { ok: false, error: "HERDR_ENV=1 is required to launch a pane" };
  }
  const command = buildAgentCommand({
    agent: input.agent,
    launchName: input.launchName,
    effort: input.effort,
  });
  const printed = redactCollectorText(`start ${command.join(" ")}; send handoff: ${input.handoff}`);
  const launchToken =
    input.existingLaunchToken ?? `launch_${Date.now()}_${randomBytes(4).toString("hex")}`;
  if (input.dryRun) {
    return { ok: true, paneCreated: false, printed, launchToken };
  }
  const agentName = herdrAgentName(input.agent, launchToken);
  const herdr =
    input.herdr ??
    createHerdrClient(async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "herdr command adapter was not injected",
    }));
  if (input.existingPaneId) {
    return sendFollowUp({
      herdr,
      paneId: input.existingPaneId,
      // An agent started by this launch token has a known name; otherwise address the pane.
      target: input.existingLaunchToken ? agentName : input.existingPaneId,
      agentName,
      text: input.handoff,
      printed,
      launchToken,
    });
  }
  const split =
    input.cwd === undefined
      ? await herdr.splitCurrent()
      : await herdr.splitCurrent({ cwd: input.cwd });
  if (!split.ok) {
    return { ok: false, error: herdrError(split, "herdr pane split failed"), launchToken };
  }
  const paneId = parseHerdrPaneId(split.stdout);
  if (!paneId) {
    return { ok: false, error: "herdr pane split did not return a pane id", launchToken };
  }
  const paneCreated = true;
  const started = await herdr.startAgent({
    name: agentName,
    kind: herdrAgentKind(input.agent),
    paneId,
    // Herdr runs the kind's own executable; pass only its native arguments after `--`.
    agentArgs: command.slice(1),
  });
  if (!started.ok) {
    // Do not leave an empty shell pane behind for a launch that never started.
    await herdr.closePane(paneId);
    return {
      ok: false,
      error: herdrError(started, "herdr agent start failed"),
      launchToken,
      paneCreated: false,
      agentName,
    };
  }
  // `agent start` returns once the agent UI is detected; let startup (MCP, skills) settle
  // first, or a prompt pasted during startup can be dropped.
  const settled = await herdr.waitFor({ target: agentName, timeoutMs: HANDOFF_TIMEOUT_MS });
  if (!settled.ok) {
    return {
      ok: false,
      error: herdrError(settled, "herdr agent wait failed"),
      launchToken,
      paneId,
      paneCreated,
      agentName,
    };
  }
  // The first handoff to an agent this launch just started stays on `herdr agent prompt`, not
  // `herdr-send`: herdr-send waits with Herdr's default --until (idle/done/blocked, i.e. the
  // whole turn) and refuses a pane still busy finishing startup, while a launch only needs to
  // see the agent start working. Follow-ups to an already-running pane use herdr-send below.
  // Wait only until the agent starts working (or asks a question), not for the whole turn.
  // Herdr returns agent_prompt_stalled when the submission produced no activity.
  const prompted = await herdr.prompt({
    target: agentName,
    text: input.handoff,
    until: ["working", "blocked"],
    timeoutMs: HANDOFF_TIMEOUT_MS,
  });
  if (!prompted.ok) {
    const output = `${prompted.stdout}${prompted.stderr}`;
    // Herdr gives an accepted prompt a fixed 5s to show working or blocked, which a slow
    // agent startup can miss even though it did receive the handoff. Confirm with a second
    // wait before calling the launch failed.
    if (output.includes("agent_prompt_stalled")) {
      const recovered = await herdr.waitFor({
        target: agentName,
        until: ["working", "blocked"],
        timeoutMs: HANDOFF_TIMEOUT_MS,
      });
      if (recovered.ok) {
        return { ok: true, paneCreated, printed, launchToken, paneId, agentName };
      }
    }
    return {
      ok: false,
      error: output.includes("agent_blocked")
        ? "agent is blocked; not resending the handoff"
        : output.includes("agent_prompt_stalled")
          ? `handoff not received by agent ${agentName} in pane ${paneId} (${herdrError(prompted, "").replace(/^: /, "")}); paste the task there or retry`
          : herdrError(prompted, "herdr agent prompt failed"),
      launchToken,
      paneId,
      paneCreated,
      printed,
      agentName,
    };
  }
  return { ok: true, paneCreated, printed, launchToken, paneId, agentName };
}

const REFUSAL_HINTS: Record<string, string> = {
  blocked: "the agent is waiting on an approval or a question",
  agent_blocked: "the agent is waiting on an approval or a question",
  blocked_screen: "an approval or question dialog is open in the pane",
  busy: "the agent is still working",
  unknown_state: "Herdr could not tell what state the agent is in",
  no_agent: "no agent with that name or pane is running",
  herdr_down: "the Herdr server did not answer",
  dialog_check_unavailable: "the pane's screen could not be checked for an open dialog",
  force_with_wait_idle: "--force and --wait-idle were combined",
};

function describeSendFailure(sent: HerdrSendResult): string {
  return [sent.reason && `reason=${sent.reason}`, sent.state && `state=${sent.state}`, sent.detail]
    .filter(Boolean)
    .join(", ");
}

/**
 * Follow-up injection into an agent that is already running, through `herdr-send` (the
 * dual-host injection contract). A refusal is final: the router never retries and never
 * passes `--force`; a person answers the pane instead.
 */
async function sendFollowUp(input: {
  herdr: HerdrClient;
  paneId: string;
  target: string;
  agentName: string;
  text: string;
  printed: string;
  launchToken: string;
}): Promise<LaunchResult> {
  const where = `${input.target === input.paneId ? "the agent" : `agent ${input.target}`} in pane ${input.paneId}`;
  const base = {
    launchToken: input.launchToken,
    paneId: input.paneId,
    paneCreated: false,
    printed: input.printed,
    agentName: input.agentName,
  };
  const sent = await input.herdr.send({
    target: input.target,
    text: input.text,
    waitIdleSec: FOLLOW_UP_WAIT_IDLE_SEC,
    timeoutMs: HANDOFF_TIMEOUT_MS,
  });
  switch (sent.result) {
    case "ok":
      return { ok: true, ...base };
    case "refused": {
      const hint = REFUSAL_HINTS[sent.reason ?? ""] ?? "herdr-send refused to type into the pane";
      return {
        ok: false,
        ...base,
        error:
          `herdr-send refused the follow-up for ${where} (${describeSendFailure(sent)}): ${hint}. ` +
          "Nothing was sent and the router will not retry; answer or check that pane yourself, then run the next phase again.",
      };
    }
    case "timeout":
      // A deadline hit while still busy is herdr-send's --wait-idle limit: nothing was sent.
      // Otherwise the prompt was accepted and Herdr saw the agent start working (a submission
      // with no activity is reported as sent_unconfirmed instead); it is still on that turn.
      if (sent.state === "busy") {
        return {
          ok: false,
          ...base,
          error:
            `${where} stayed busy for ${FOLLOW_UP_WAIT_IDLE_SEC}s, so the follow-up was not sent. ` +
            "Run the next phase again once it is idle.",
        };
      }
      return { ok: true, ...base };
    case "sent_unconfirmed": {
      // The text was submitted; resending would duplicate it. Give the agent one more window.
      const started = await input.herdr.waitFor({
        target: input.target,
        until: ["working", "blocked"],
        timeoutMs: HANDOFF_TIMEOUT_MS,
      });
      if (started.ok) {
        return { ok: true, ...base };
      }
      return {
        ok: false,
        ...base,
        sentUnconfirmed: true,
        error:
          `Sent the follow-up to ${where}, but could not confirm it started (${describeSendFailure(sent)}). ` +
          "Do not resend it; check that pane first.",
      };
    }
    case "unavailable":
      return {
        ok: false,
        ...base,
        error: `cannot send a follow-up to ${where}: ${sent.detail ?? "herdr-send is not installed"}`,
      };
    default:
      return {
        ok: false,
        ...base,
        error: `herdr-send failed for ${where} (exit ${sent.code}${describeSendFailure(sent) ? `, ${describeSendFailure(sent)}` : ""})`,
      };
  }
}
