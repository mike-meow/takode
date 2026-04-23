import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalManager } from "./terminal-manager.js";

type SpawnTerminalOptions = Parameters<typeof Bun.spawn>[1];

describe("TerminalManager", () => {
  let spawnOptions: SpawnTerminalOptions | undefined;
  let fakeTerminal: { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let fakeProc: {
    pid: number;
    exitCode: number;
    exited: Promise<number>;
    kill: ReturnType<typeof vi.fn>;
    terminal: typeof fakeTerminal;
  };

  beforeEach(() => {
    fakeTerminal = {
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
    };
    fakeProc = {
      pid: 1234,
      exitCode: 0,
      exited: Promise.resolve(0),
      kill: vi.fn(),
      terminal: fakeTerminal,
    };
    spawnOptions = undefined;
    vi.spyOn(Bun, "spawn").mockImplementation(((_cmd: string[], opts?: SpawnTerminalOptions) => {
      spawnOptions = opts;
      return fakeProc as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn);
  });

  it("replays buffered output to a socket that attaches after spawn", () => {
    const manager = new TerminalManager();
    const terminalId = manager.spawn("session-a", "/repo");
    const ws = { sendBinary: vi.fn(), send: vi.fn() } as any;

    ((spawnOptions as any)?.terminal?.data as ((terminal: unknown, data: Uint8Array) => void) | undefined)?.(
      fakeTerminal,
      new Uint8Array([36, 32]),
    );
    manager.addBrowserSocket(terminalId, ws);

    expect(ws.sendBinary).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it("keeps separate long-lived terminals per session key", () => {
    const manager = new TerminalManager();

    const first = manager.spawn("session-a", "/repo/a");
    const second = manager.spawn("session-b", "/repo/b");

    expect(first).not.toBe(second);
    expect(manager.getInfo("session-a")).toEqual({ id: first, cwd: "/repo/a" });
    expect(manager.getInfo("session-b")).toEqual({ id: second, cwd: "/repo/b" });
  });
});
