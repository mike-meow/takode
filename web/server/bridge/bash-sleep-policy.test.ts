import { describe, expect, it } from "vitest";
import { detectLongSleepBashCommand } from "./bash-sleep-policy.js";

describe("bash sleep policy", () => {
  it("allows sleep commands up to 60 seconds", () => {
    expect(detectLongSleepBashCommand("sleep 60")).toBeNull();
    expect(detectLongSleepBashCommand("sleep 30 && echo done")).toBeNull();
    expect(detectLongSleepBashCommand("sleep 30 && sleep 40")).toBeNull();
    expect(detectLongSleepBashCommand("sleep 1m")).toBeNull();
    expect(detectLongSleepBashCommand("sleep 60 2>&1")).toBeNull();
    expect(detectLongSleepBashCommand("sleep 60 2>/tmp/err")).toBeNull();
  });

  it("detects direct sleeps longer than 60 seconds", () => {
    expect(detectLongSleepBashCommand("sleep 61")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "sleep 61" }),
    );
    expect(detectLongSleepBashCommand("/bin/sleep 600")).toEqual(
      expect.objectContaining({ durationSeconds: 600, subcommand: "/bin/sleep 600" }),
    );
  });

  it("detects long sleeps inside compound commands without using substring matching", () => {
    expect(detectLongSleepBashCommand("echo hi && sleep 61 && pwd")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "sleep 61" }),
    );
    expect(detectLongSleepBashCommand("sleep 61 & echo hi")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "sleep 61" }),
    );
    expect(detectLongSleepBashCommand("printf 'sleep 999' && true")).toBeNull();
  });

  it("handles boundary and GNU-style duration arguments correctly", () => {
    expect(detectLongSleepBashCommand("sleep 60.1")).toEqual(
      expect.objectContaining({ durationSeconds: 60.1, subcommand: "sleep 60.1" }),
    );
    expect(detectLongSleepBashCommand("sleep 30 31")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "sleep 30 31" }),
    );
    expect(detectLongSleepBashCommand("sleep 1m 1s")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "sleep 1m 1s" }),
    );
    expect(detectLongSleepBashCommand("sleep infinity")).toEqual(
      expect.objectContaining({ durationSeconds: Number.POSITIVE_INFINITY, subcommand: "sleep infinity" }),
    );
  });

  it("supports common wrappers around sleep while ignoring malformed matches", () => {
    expect(detectLongSleepBashCommand("env FOO=bar sleep 61")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "env FOO=bar sleep 61" }),
    );
    expect(detectLongSleepBashCommand("env -i sleep 61")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "env -i sleep 61" }),
    );
    expect(detectLongSleepBashCommand("time -p sleep 61")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "time -p sleep 61" }),
    );
    expect(detectLongSleepBashCommand("sudo -u root sleep 61")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "sudo -u root sleep 61" }),
    );
    expect(detectLongSleepBashCommand("env FOO=bar sleep 61 &")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "env FOO=bar sleep 61" }),
    );
    expect(detectLongSleepBashCommand("command sleep 61 >/tmp/out")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "command sleep 61 > /tmp/out" }),
    );
    expect(detectLongSleepBashCommand("sleep --verbose 61")).toEqual(
      expect.objectContaining({ durationSeconds: 61, subcommand: "sleep --verbose 61" }),
    );
    expect(detectLongSleepBashCommand("sleep --help")).toBeNull();
  });
});
