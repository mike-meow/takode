// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createMessageLinkHandoff } from "./message-link-handoff.js";

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  private listeners = new Set<(event: MessageEvent<any>) => void>();

  constructor(public name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(message: unknown) {
    const peers = FakeBroadcastChannel.channels.get(this.name) ?? new Set();
    for (const peer of peers) {
      if (peer === this) continue;
      for (const listener of peer.listeners) {
        listener({ data: message } as MessageEvent);
      }
    }
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<any>) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<any>) => void) {
    this.listeners.delete(listener);
  }

  close() {
    const peers = FakeBroadcastChannel.channels.get(this.name);
    peers?.delete(this);
    if (peers && peers.size === 0) {
      FakeBroadcastChannel.channels.delete(this.name);
    }
  }
}

describe("createMessageLinkHandoff", () => {
  it("navigates an existing same-server tab and acknowledges reuse", async () => {
    const originalChannel = globalThis.BroadcastChannel;
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel as any);

    const handledHashes: string[] = [];
    const first = createMessageLinkHandoff({
      serverId: "server-a",
      onNavigateHash: (hash) => handledHashes.push(hash),
      timeoutMs: 50,
    });
    const second = createMessageLinkHandoff({
      serverId: "server-a",
      onNavigateHash: () => {},
      timeoutMs: 50,
    });

    try {
      await expect(second.requestReuse("#/session/123/msg/asst-42")).resolves.toBe(true);
      expect(handledHashes).toEqual(["#/session/123/msg/asst-42"]);
      expect(focusSpy).toHaveBeenCalled();
    } finally {
      first.cleanup();
      second.cleanup();
      focusSpy.mockRestore();
      if (originalChannel) {
        vi.stubGlobal("BroadcastChannel", originalChannel);
      } else {
        vi.unstubAllGlobals();
      }
    }
  });

  it("grants the handoff to only one existing same-server tab when multiple peers are open", async () => {
    const originalChannel = globalThis.BroadcastChannel;
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel as any);

    const firstHandledHashes: string[] = [];
    const secondHandledHashes: string[] = [];
    const first = createMessageLinkHandoff({
      serverId: "server-multi",
      onNavigateHash: (hash) => firstHandledHashes.push(hash),
      timeoutMs: 50,
    });
    const second = createMessageLinkHandoff({
      serverId: "server-multi",
      onNavigateHash: (hash) => secondHandledHashes.push(hash),
      timeoutMs: 50,
    });
    const requester = createMessageLinkHandoff({
      serverId: "server-multi",
      onNavigateHash: () => {},
      timeoutMs: 50,
    });

    try {
      await expect(requester.requestReuse("#/session/123/msg/asst-42")).resolves.toBe(true);
      const totalNavigations = firstHandledHashes.length + secondHandledHashes.length;
      expect(totalNavigations).toBe(1);
      expect([firstHandledHashes, secondHandledHashes]).toContainEqual(["#/session/123/msg/asst-42"]);
      expect(focusSpy).toHaveBeenCalledTimes(1);
    } finally {
      first.cleanup();
      second.cleanup();
      requester.cleanup();
      focusSpy.mockRestore();
      if (originalChannel) {
        vi.stubGlobal("BroadcastChannel", originalChannel);
      } else {
        vi.unstubAllGlobals();
      }
    }
  });

  it("times out cleanly when no same-server peer responds", async () => {
    const originalChannel = globalThis.BroadcastChannel;
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel as any);
    const handoff = createMessageLinkHandoff({
      serverId: "server-b",
      onNavigateHash: () => {},
      timeoutMs: 10,
    });

    try {
      await expect(handoff.requestReuse("#/session/123/msg/asst-42")).resolves.toBe(false);
    } finally {
      handoff.cleanup();
      if (originalChannel) {
        vi.stubGlobal("BroadcastChannel", originalChannel);
      } else {
        vi.unstubAllGlobals();
      }
    }
  });
});
