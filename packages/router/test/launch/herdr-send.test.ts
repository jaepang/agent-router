import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHerdrClient,
  parseHerdrSendResult,
  resolveHerdrSendBin,
  type CommandResult,
} from "../../src/launch/herdr-client.js";
import { launchRoutedAgent } from "../../src/launch/herdr-launcher.js";

type Reply = Omit<CommandResult, "ok"> & { ok?: boolean };

/** A fake Herdr whose `herdr-send` exits as told; every call is recorded. */
function fakeHerdr(send: Reply, options: { waitOk?: boolean } = {}) {
  const calls: string[][] = [];
  const client = createHerdrClient(async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "herdr-send") {
      return { ok: send.code === 0, ...send };
    }
    if (argv[1] === "agent" && argv[2] === "wait") {
      const ok = options.waitOk ?? true;
      return { ok, code: ok ? 0 : 1, stdout: "", stderr: ok ? "" : "timeout" };
    }
    const pane = argv[1] === "pane" && argv[2] === "split";
    return { ok: true, code: 0, stdout: pane ? "w1:p9\n" : "", stderr: "" };
  });
  return { client, calls };
}

function followUp(herdr: ReturnType<typeof fakeHerdr>, handoff = "next phase") {
  return launchRoutedAgent({
    env: { HERDR_ENV: "1" },
    agent: "claude-code",
    launchName: "opus",
    effort: "high",
    handoff,
    dryRun: false,
    herdr: herdr.client,
    existingLaunchToken: "launch_1_abcd",
    existingPaneId: "w1:p9",
  });
}

const json = (value: object) => `${JSON.stringify(value)}\n`;

describe("follow-up injection through herdr-send", () => {
  it("sends with --wait-idle, --timeout and --json, never --force, and nothing else", async () => {
    const herdr = fakeHerdr({
      code: 0,
      stdout: json({ result: "ok", state: "working" }),
      stderr: "",
    });
    const result = await followUp(herdr, "--looks-like-a-flag");
    expect(result).toMatchObject({ ok: true, paneId: "w1:p9", paneCreated: false });
    expect(herdr.calls).toHaveLength(1);
    const argv = herdr.calls[0]!;
    expect(argv[0]).toBe("herdr-send");
    expect(argv).not.toContain("--force");
    expect(argv.slice(1, 7)).toEqual(["--wait-idle", "15", "--timeout", "30000", "--json", "--"]);
    expect(argv[7]).toMatch(/^router-claude-[0-9a-f]{6}$/);
    expect(argv[8]).toBe("--looks-like-a-flag");
  });

  it("addresses the pane id when there is no launch token to name the agent", async () => {
    const herdr = fakeHerdr({ code: 0, stdout: json({ result: "ok" }), stderr: "" });
    await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "cursor",
      launchName: "grok-4.6",
      effort: "medium",
      handoff: "next",
      dryRun: false,
      herdr: herdr.client,
      existingPaneId: "w1:p3",
    });
    expect(herdr.calls[0]!.slice(-2)).toEqual(["w1:p3", "next"]);
  });

  it.each([
    ["blocked", /approval or a question/],
    ["agent_blocked", /approval or a question/],
    ["blocked_screen", /dialog is open/],
    ["unknown_state", /could not tell/],
    ["no_agent", /no agent/],
    ["dialog_check_unavailable", /screen could not be checked/],
  ])("exit 2 (%s): refuses once, tells a person to answer the pane", async (reason, hint) => {
    const herdr = fakeHerdr({
      code: 2,
      stdout: json({ result: "refused", reason, state: "blocked" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`reason=${reason}`);
    expect(result.error).toMatch(hint);
    expect(result.error).toMatch(/Nothing was sent and the router will not retry/);
    expect(result.error).toMatch(/answer or check that pane yourself/);
    // No retry, no --force, no fallback to a raw prompt.
    expect(herdr.calls).toHaveLength(1);
    expect(result.sentUnconfirmed).toBeUndefined();
  });

  it("exit 3 while still busy: the --wait-idle deadline passed and nothing was sent", async () => {
    const herdr = fakeHerdr({
      code: 3,
      stdout: json({ result: "timeout", state: "busy" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stayed busy for 15s, so the follow-up was not sent/);
    expect(herdr.calls).toHaveLength(1);
  });

  it("exit 3 after an idle send: accepted and working past the wait, so not an error", async () => {
    const herdr = fakeHerdr({
      code: 3,
      stdout: json({ result: "timeout", state: "idle" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(true);
    expect(herdr.calls).toHaveLength(1);
  });

  it("exit 4: confirms with one more wait and never resends", async () => {
    const herdr = fakeHerdr({
      code: 4,
      stdout: json({ result: "sent_unconfirmed", reason: "agent_prompt_stalled", state: "idle" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(true);
    expect(
      herdr.calls.map((argv) => argv[0] === "herdr-send" || argv.slice(1, 3).join(" ")),
    ).toEqual([true, "agent wait"]);
    expect(herdr.calls[1]).toEqual(
      expect.arrayContaining(["--until", "working", "--until", "blocked"]),
    );
  });

  it("exit 4 still unconfirmed: reports it as sent-unconfirmed with do-not-resend", async () => {
    const herdr = fakeHerdr(
      {
        code: 4,
        stdout: json({
          result: "sent_unconfirmed",
          reason: "agent_prompt_stalled",
          state: "idle",
          confirmed_by_screen: false,
        }),
        stderr: "",
      },
      { waitOk: false },
    );
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.sentUnconfirmed).toBe(true);
    expect(result.error).toMatch(/Do not resend it/);
    expect(herdr.calls.filter((argv) => argv[0] === "herdr-send")).toHaveLength(1);
  });

  it("exit 1: reports herdr-send's error code", async () => {
    const herdr = fakeHerdr({
      code: 1,
      stdout: json({ result: "error", reason: "herdr_error", state: "idle" }),
      stderr: "",
    });
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/herdr-send failed .*exit 1, reason=herdr_error/);
  });

  it("a missing binary fails clearly instead of as a spawn error", async () => {
    const herdr = fakeHerdr({ code: 1, stdout: "", stderr: "Error: spawn herdr-send ENOENT" });
    const result = await followUp(herdr);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot send a follow-up .*ENOENT/);
  });

  it("does not spawn anything when herdr-send was not resolved", async () => {
    const calls: string[][] = [];
    const client = createHerdrClient(
      async (argv) => {
        calls.push([...argv]);
        return { ok: true, code: 0, stdout: "", stderr: "" };
      },
      { herdrSendMissing: "herdr-send was not found on PATH" },
    );
    const result = await followUp({ client, calls });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/herdr-send was not found on PATH/);
    expect(calls).toEqual([]);
  });

  it("uses the resolved herdr-send path", async () => {
    const calls: string[][] = [];
    const client = createHerdrClient(
      async (argv) => {
        calls.push([...argv]);
        return { ok: true, code: 0, stdout: json({ result: "ok" }), stderr: "" };
      },
      { herdrSendBin: "/opt/bin/herdr-send" },
    );
    await followUp({ client, calls });
    expect(calls[0]![0]).toBe("/opt/bin/herdr-send");
  });
});

describe("fresh launch handoff", () => {
  it("keeps the first handoff on `herdr agent prompt --until working --until blocked`", async () => {
    const herdr = fakeHerdr({ code: 0, stdout: "", stderr: "" });
    const result = await launchRoutedAgent({
      env: { HERDR_ENV: "1" },
      agent: "claude-code",
      launchName: "opus",
      effort: "high",
      handoff: "task",
      dryRun: false,
      herdr: herdr.client,
      cwd: "/x",
    });
    expect(result.ok).toBe(true);
    expect(herdr.calls.some((argv) => argv[0] === "herdr-send")).toBe(false);
    const prompt = herdr.calls.find((argv) => argv[2] === "prompt")!;
    expect(prompt).toEqual(expect.arrayContaining(["--until", "working", "--until", "blocked"]));
    expect(herdr.calls[0]).toEqual([
      "herdr",
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      "/x",
      "--no-focus",
    ]);
  });
});

describe("parseHerdrSendResult", () => {
  it("lets the exit code decide and JSON fill in reason and state", () => {
    expect(
      parseHerdrSendResult({
        ok: false,
        code: 2,
        stdout: json({ result: "refused", reason: "busy", state: "busy" }),
        stderr: "",
      }),
    ).toEqual({ result: "refused", code: 2, reason: "busy", state: "busy" });
    expect(
      parseHerdrSendResult({ ok: false, code: 1, stdout: "", stderr: "usage: herdr-send ..." }),
    ).toEqual({ result: "error", code: 1, detail: "usage: herdr-send ..." });
    expect(
      parseHerdrSendResult({
        ok: false,
        code: 4,
        stdout: json({
          result: "sent_unconfirmed",
          reason: "agent_prompt_stalled",
          state: "idle",
          confirmed_by_screen: true,
        }),
        stderr: "",
      }),
    ).toEqual({
      result: "sent_unconfirmed",
      code: 4,
      reason: "agent_prompt_stalled",
      state: "idle",
      confirmedByScreen: true,
    });
  });
});

describe("resolveHerdrSendBin", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-send-path-"));
  const bin = path.join(dir, "herdr-send");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const plain = path.join(dir, "not-executable");
  writeFileSync(plain, "", { mode: 0o644 });

  it("finds herdr-send on PATH", () => {
    expect(resolveHerdrSendBin({ PATH: `/nonexistent:${dir}` })).toEqual({ bin });
  });

  it("prefers HERDR_SEND_BIN", () => {
    expect(resolveHerdrSendBin({ PATH: "", HERDR_SEND_BIN: bin })).toEqual({ bin });
  });

  it("explains what is missing", () => {
    expect(resolveHerdrSendBin({ PATH: "/nonexistent" }).error).toMatch(
      /herdr-send was not found on PATH.*HERDR_SEND_BIN/,
    );
    expect(resolveHerdrSendBin({ PATH: dir, HERDR_SEND_BIN: plain }).error).toMatch(
      /is not an executable file/,
    );
  });
});
