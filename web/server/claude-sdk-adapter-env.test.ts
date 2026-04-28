import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetEnrichedPath = vi.hoisted(() => vi.fn(() => "/usr/bin:/usr/local/bin"));
vi.mock("./path-resolver.js", () => ({
  getEnrichedPath: mockGetEnrichedPath,
}));

const sdkMocks = vi.hoisted(() => {
  class MockTransport {
    options: Record<string, unknown> = {};
    initialize(): void {}
  }

  class MockQuery {
    initConfig: Record<string, unknown> = {};
    initialize(): Promise<void> {
      return Promise.resolve();
    }
  }

  const makeSession = () => ({
    close: vi.fn(),
    query: {
      transport: new MockTransport(),
      constructor: MockQuery,
    },
  });

  return {
    createSession: vi.fn((_options: unknown) => makeSession()),
    resumeSession: vi.fn((_sessionId: string, _options: unknown) => makeSession()),
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  unstable_v2_createSession: sdkMocks.createSession,
  unstable_v2_resumeSession: sdkMocks.resumeSession,
}));

import { ClaudeSdkAdapter } from "./claude-sdk-adapter.js";

describe("ClaudeSdkAdapter launch env", () => {
  const originalGitEditor = process.env.GIT_EDITOR;
  const originalGitSequenceEditor = process.env.GIT_SEQUENCE_EDITOR;

  afterEach(() => {
    vi.clearAllMocks();
    if (originalGitEditor === undefined) {
      delete process.env.GIT_EDITOR;
    } else {
      process.env.GIT_EDITOR = originalGitEditor;
    }
    if (originalGitSequenceEditor === undefined) {
      delete process.env.GIT_SEQUENCE_EDITOR;
    } else {
      process.env.GIT_SEQUENCE_EDITOR = originalGitSequenceEditor;
    }
  });

  it("enforces noninteractive Git editors in SDK sessionOptions.env", async () => {
    // The SDK adapter builds sessionOptions.env itself, so launcher-level spawn
    // assertions do not cover the subprocess environment used by Claude SDK.
    process.env.GIT_EDITOR = "code --wait";
    process.env.GIT_SEQUENCE_EDITOR = "vim";

    new ClaudeSdkAdapter("sdk-session", {
      cwd: process.cwd(),
      env: {
        COMPANION_SERVER_ID: "test-server-id",
        GIT_EDITOR: "nano",
        GIT_SEQUENCE_EDITOR: "emacs",
        EDITOR: "code --wait",
        VISUAL: "code --wait",
      },
    });

    await vi.waitFor(() => expect(sdkMocks.createSession).toHaveBeenCalledTimes(2));

    const sessionOptions = sdkMocks.createSession.mock.calls[1][0] as {
      env: Record<string, string | undefined>;
    };
    expect(sessionOptions.env.GIT_EDITOR).toBe("true");
    expect(sessionOptions.env.GIT_SEQUENCE_EDITOR).toBe("true");
    expect(sessionOptions.env.EDITOR).toBe("code --wait");
    expect(sessionOptions.env.VISUAL).toBe("code --wait");
  });
});
