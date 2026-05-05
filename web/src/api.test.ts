// @vitest-environment jsdom
import { ApiError, api, getTranscriptionRequestTimeoutMs, resolveAudioUploadFilename } from "./api.js";
import type { VoiceTranscriptionResult } from "./api.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// createSession
// ===========================================================================
describe("createSession", () => {
  it("sends POST to /api/sessions/create with body", async () => {
    const responseData = { sessionId: "s1", state: "starting", cwd: "/home" };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    const result = await api.createSession({ model: "opus", cwd: "/home" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/create");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ model: "opus", cwd: "/home" });
    expect(result).toEqual(responseData);
  });

  it("passes codexInternetAccess when provided", async () => {
    const responseData = { sessionId: "s2", state: "starting", cwd: "/repo" };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    await api.createSession({
      backend: "codex",
      cwd: "/repo",
      codexInternetAccess: true,
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      backend: "codex",
      cwd: "/repo",
      codexInternetAccess: true,
    });
  });

  it("passes codexReasoningEffort when provided", async () => {
    const responseData = { sessionId: "s4", state: "starting", cwd: "/repo" };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    await api.createSession({
      backend: "codex",
      cwd: "/repo",
      codexReasoningEffort: "high",
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      backend: "codex",
      cwd: "/repo",
      codexReasoningEffort: "high",
    });
  });

  it("passes container options when provided", async () => {
    const responseData = { sessionId: "s3", state: "starting", cwd: "/repo" };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    await api.createSession({
      backend: "claude",
      cwd: "/repo",
      container: {
        image: "companion-core:latest",
        ports: [3000, 5173],
      },
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      backend: "claude",
      cwd: "/repo",
      container: {
        image: "companion-core:latest",
        ports: [3000, 5173],
      },
    });
  });
});

// ===========================================================================
// listSessions
// ===========================================================================
describe("listSessions", () => {
  it("sends GET to /api/sessions", async () => {
    const sessions = [{ sessionId: "s1", state: "connected", cwd: "/tmp" }];
    mockFetch.mockResolvedValueOnce(mockResponse(sessions));

    const result = await api.listSessions();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions");
    expect(opts).toBeUndefined();
    expect(result).toEqual(sessions);
  });
});

describe("refreshSessionGitStatus", () => {
  it("posts to the manual session git refresh endpoint", async () => {
    const responseData = {
      ok: true,
      gitBranch: "feature",
      gitDefaultBranch: "main",
      diffBaseBranch: "main",
      gitAhead: 0,
      gitBehind: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      gitStatusRefreshedAt: 123,
      gitStatusRefreshError: null,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    const result = await api.refreshSessionGitStatus("s/1");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/s%2F1/git-status/refresh");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeUndefined();
    expect(result).toEqual(responseData);
  });

  it("can request the cheap automatic refresh mode", async () => {
    const responseData = {
      ok: true,
      gitBranch: "feature",
      gitDefaultBranch: "main",
      diffBaseBranch: "main",
      gitAhead: 0,
      gitBehind: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      gitStatusRefreshedAt: 123,
      gitStatusRefreshError: null,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    const result = await api.refreshSessionGitStatus("s1", { force: false });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/s1/git-status/refresh");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ force: false });
    expect(result).toEqual(responseData);
  });
});

// ===========================================================================
// listQuestPage
// ===========================================================================
describe("listQuestPage", () => {
  it("passes session filters through the paged Questmaster route", async () => {
    const page = {
      quests: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
      previousOffset: null,
      counts: { all: 0, idea: 0, refined: 0, in_progress: 0, done: 0 },
      allTags: [],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(page));

    const result = await api.listQuestPage({ sessionId: "session-1", session: "session-alias", limit: 50 });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/quests/_page?limit=50&session=session-alias&sessionId=session-1");
    expect(opts).toBeUndefined();
    expect(result).toEqual(page);
  });
});

// ===========================================================================
// killSession
// ===========================================================================
describe("killSession", () => {
  it("sends POST with URL-encoded session ID", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.killSession("session/with/slashes");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/sessions/${encodeURIComponent("session/with/slashes")}/kill`);
    expect(opts.method).toBe("POST");
  });
});

// ===========================================================================
// deleteSession
// ===========================================================================
describe("deleteSession", () => {
  it("sends DELETE with URL-encoded session ID", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.deleteSession("session&id=1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/sessions/${encodeURIComponent("session&id=1")}`);
    expect(opts.method).toBe("DELETE");
  });
});

// ===========================================================================
// searchSessions
// ===========================================================================
describe("searchSessions", () => {
  it("passes reviewer inclusion explicitly when requested", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ query: "review", tookMs: 1, totalMatches: 0, results: [] }));

    await api.searchSessions("review", {
      includeArchived: true,
      includeReviewers: true,
      messageLimitPerSession: 75,
      limit: 25,
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/sessions/search?");
    expect(url).toContain("q=review");
    expect(url).toContain("includeArchived=true");
    expect(url).toContain("includeReviewers=true");
    expect(url).toContain("messageLimitPerSession=75");
    expect(url).toContain("limit=25");
  });
});

// ===========================================================================
// herdSessions
// ===========================================================================
describe("herdSessions", () => {
  it("omits force when not requested", async () => {
    // The Takode CLI should preserve the normal herd contract unless the user
    // explicitly opts into force takeover.
    mockFetch.mockResolvedValueOnce(mockResponse({ herded: ["worker-1"], notFound: [] }));

    await api.herdSessions("leader-1", ["worker-1"]);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/sessions/${encodeURIComponent("leader-1")}/herd`);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ workerIds: ["worker-1"] });
  });

  it("includes force when requested", async () => {
    // Force takeover must be explicit on the wire so the server can preserve
    // the ordinary conflict path for default herd requests.
    mockFetch.mockResolvedValueOnce(
      mockResponse({ herded: ["worker-1"], notFound: [], reassigned: [{ id: "worker-1", fromLeader: "leader-9" }] }),
    );

    await api.herdSessions("leader-1", ["worker-1"], { force: true });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ workerIds: ["worker-1"], force: true });
  });
});

describe("herdWorkerToLeader", () => {
  it("sends the browser-safe herd route without force by default", async () => {
    // The web UI uses a separate local endpoint because browser requests do not
    // carry Takode auth headers.
    mockFetch.mockResolvedValueOnce(
      mockResponse({ herded: ["worker-1"], notFound: [], conflicts: [], reassigned: [], leaders: [] }),
    );

    await api.herdWorkerToLeader("worker-1", "leader-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/sessions/${encodeURIComponent("worker-1")}/herd-to`);
    expect(JSON.parse(opts.body)).toEqual({ leaderSessionId: "leader-1" });
  });

  it("passes force through on the browser-safe herd route when requested", async () => {
    // The browser path still needs to preserve the explicit force signal rather
    // than silently upgrading ordinary herd actions.
    mockFetch.mockResolvedValueOnce(
      mockResponse({ herded: ["worker-1"], notFound: [], conflicts: [], reassigned: [], leaders: [] }),
    );

    await api.herdWorkerToLeader("worker-1", "leader-1", { force: true });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ leaderSessionId: "leader-1", force: true });
  });
});

// ===========================================================================
// post() error handling
// ===========================================================================
describe("post() error handling", () => {
  it("throws with error message from JSON body on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Session not found" }, 404));

    await expect(api.killSession("nonexistent")).rejects.toThrow("Session not found");
  });

  it("preserves structured error bodies for callers that need rich failure details", async () => {
    const result = {
      ok: false,
      operationId: "prep-1",
      mode: "restart",
      restartRequested: false,
      timedOut: true,
      interrupted: [{ sessionId: "worker-1", label: "Worker session", reasons: ["running"] }],
      skipped: [],
      failures: [],
      protectedLeaders: [{ sessionId: "leader-1", label: "Leader session" }],
      unresolvedBlockers: [{ sessionId: "approval-1", label: "Approval session", reasons: ["1 pending permission"] }],
      herdDelivery: { suppressed: 0, held: 0, trackingActive: true, countsFinal: false },
    };
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Cannot restart", result }, 409));

    await expect(api.restartServer()).rejects.toMatchObject({
      name: "ApiError",
      message: "Cannot restart",
      status: 409,
      body: { error: "Cannot restart", result },
    } satisfies Partial<ApiError>);
  });

  it("falls back to statusText when JSON body has no error field", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}, 500));

    await expect(api.killSession("bad")).rejects.toThrow("Error");
  });
});

// ===========================================================================
// get() error handling
// ===========================================================================
describe("get() error handling", () => {
  it("throws error message from JSON body on non-ok GET responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: () => Promise.resolve({ error: "Invalid log regex: (" }),
    });

    await expect(api.listSessions()).rejects.toThrow("Invalid log regex: (");
  });

  it("falls back to statusText when non-ok GET responses have no error field", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: () => Promise.resolve({}),
    });

    await expect(api.listSessions()).rejects.toThrow("Forbidden");
  });

  it("throws on network failures", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    await expect(api.listSessions()).rejects.toThrow("Network down");
  });
});

// ===========================================================================
// listDirs
// ===========================================================================
describe("listDirs", () => {
  it("includes query param when path is provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ path: "/home", dirs: [], home: "/home" }));

    await api.listDirs("/home/user");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/list?path=${encodeURIComponent("/home/user")}`);
  });

  it("omits query param when path is not provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ path: "/", dirs: [], home: "/home" }));

    await api.listDirs();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/fs/list");
  });
});

// ===========================================================================
// resolveAudioUploadFilename
// ===========================================================================
describe("resolveAudioUploadFilename", () => {
  it("preserves mp4 uploads for Safari-style recorder blobs", () => {
    expect(resolveAudioUploadFilename("audio/mp4;codecs=mp4a.40.2")).toBe("recording.mp4");
  });

  it("keeps webm as the default fallback", () => {
    expect(resolveAudioUploadFilename("")).toBe("recording.webm");
  });
});

// ===========================================================================
// getTranscriptionRequestTimeoutMs
// ===========================================================================
describe("getTranscriptionRequestTimeoutMs", () => {
  it("keeps short dictation at the legacy 45-second timeout", () => {
    // Short recordings should preserve the fast failure behavior users already
    // expect instead of silently stretching every transcription request.
    expect(getTranscriptionRequestTimeoutMs(8 * 1024)).toBe(45_000);
  });

  it("extends the pre-response timeout for larger mobile uploads", () => {
    // q-359: longer mobile recordings spend significant time uploading before
    // the transcription route can start its SSE response, so larger blobs need
    // a larger timeout budget than the old fixed 45 seconds.
    expect(getTranscriptionRequestTimeoutMs(1_024 * 1_024)).toBe(60_000);
    expect(getTranscriptionRequestTimeoutMs(20 * 1_024 * 1_024)).toBe(180_000);
  });
});

// ===========================================================================
// transcribe
// ===========================================================================
describe("transcribe", () => {
  it("allows larger recordings to outlive the old fixed timeout before aborting", async () => {
    // q-359 regression: the request timeout applies before the SSE stream even
    // begins, so large mobile uploads should get more than the old 45-second
    // budget to finish the multipart upload and server body parsing.
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementationOnce((_url, opts?: RequestInit) => {
        const signal = opts?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      });

      const largeAudio = new Blob([new Uint8Array(1_024 * 1_024)], { type: "audio/mp4" });
      const timeoutMs = getTranscriptionRequestTimeoutMs(largeAudio.size);
      let settled = false;
      let rejectionMessage = "";

      const pending = api.transcribe(largeAudio).catch((err) => {
        settled = true;
        rejectionMessage = err instanceof Error ? err.message : String(err);
      });

      await vi.advanceTimersByTimeAsync(45_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(timeoutMs - 45_000);
      await pending;

      expect(settled).toBe(true);
      expect(rejectionMessage).toContain("60s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces preparing before the SSE response opens, then switches to transcribing", async () => {
    // q-485: mobile upload time happens before the server can open the SSE
    // stream, so the client must stay in a pre-STT preparation state until the server
    // actually flushes the first SSE chunk acknowledging STT has started.
    const encoder = new TextEncoder();
    let resolveResponse: ((value: Response | PromiseLike<Response>) => void) | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );

    const onPhase = vi.fn();
    const pending = api.transcribe(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), { onPhase });

    expect(onPhase.mock.calls).toEqual([["preparing"]]);

    if (!resolveResponse) throw new Error("transcription response resolver was not initialized");
    resolveResponse(
      new Response(
        new ReadableStream({
          start(controller) {
            streamController = controller;
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    await Promise.resolve();
    expect(onPhase.mock.calls).toEqual([["preparing"]]);

    if (!streamController) throw new Error("stream controller was not initialized");
    streamController.enqueue(encoder.encode('event: phase\ndata: {"phase":"transcribing","mode":"dictation"}\n\n'));
    streamController.enqueue(
      encoder.encode(
        `event: result\ndata: ${JSON.stringify({
          text: "hello",
          backend: "openai",
          enhanced: false,
        } satisfies VoiceTranscriptionResult)}\n\n`,
      ),
    );
    streamController.close();

    await pending;
    expect(onPhase.mock.calls).toEqual([["preparing"], ["transcribing"]]);
  });

  it("uses raw audio transport for empty-draft dictation and parses the SSE result", async () => {
    // q-566: the common mobile dictation path should avoid multipart overhead
    // and send the audio blob directly while preserving the phase-aware SSE flow.
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: phase\ndata: {"phase":"transcribing","mode":"dictation"}\n\n'));
        controller.enqueue(
          encoder.encode(
            `event: result\ndata: ${JSON.stringify({
              text: "hello",
              backend: "openai",
              enhanced: false,
            } satisfies VoiceTranscriptionResult)}\n\n`,
          ),
        );
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const onPhase = vi.fn();
    const shortAudio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mp4" });
    const result = await api.transcribe(shortAudio, {
      mode: "dictation",
      sessionId: "session-1",
      backend: "openai",
      onPhase,
    });

    expect(onPhase.mock.calls).toEqual([["preparing"], ["transcribing"]]);
    expect(result).toEqual({
      text: "hello",
      backend: "openai",
      enhanced: false,
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/transcribe?backend=openai&mode=dictation&sessionId=session-1");
    expect(opts?.method).toBe("POST");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(opts?.body).toBe(shortAudio);
    expect(opts?.headers).toBeInstanceOf(Headers);
    const headers = opts?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("audio/mp4");
    expect(headers.get("X-Companion-Audio-Filename")).toBe("recording.mp4");
  });

  it("keeps multipart transport for voice edit requests and parses the SSE result", async () => {
    // Edit/append still need the existing composer text, so keep the multipart
    // path working while the empty-draft dictation path is optimized separately.
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: phase\ndata: {"phase":"transcribing","mode":"edit"}\n\n'));
        controller.enqueue(
          encoder.encode(
            'event: stt_complete\ndata: {"rawText":"turn this into bullets","nextPhase":"editing","mode":"edit"}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'event: result\ndata: {"text":"- first\\n- second","rawText":"turn this into bullets","instructionText":"turn this into bullets","mode":"edit","backend":"openai","enhanced":true}\n\n',
          ),
        );
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const onPhase = vi.fn();
    const shortAudio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
    const result = await api.transcribe(shortAudio, {
      mode: "edit",
      composerText: "draft text",
      sessionId: "session-1",
      onPhase,
    });

    expect(onPhase.mock.calls).toEqual([["preparing"], ["transcribing"], ["editing"]]);
    expect(result).toEqual({
      text: "- first\n- second",
      rawText: "turn this into bullets",
      instructionText: "turn this into bullets",
      mode: "edit",
      backend: "openai",
      enhanced: true,
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/transcribe?mode=edit&sessionId=session-1");
    expect(opts?.method).toBe("POST");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    const form = opts?.body as FormData;
    const uploadedAudio = form.get("audio");
    expect(uploadedAudio).toBeInstanceOf(File);
    expect((uploadedAudio as File).name).toBe("recording.webm");
    expect(form.get("mode")).toBe("edit");
    expect(form.get("composerText")).toBe("draft text");
    expect(form.get("sessionId")).toBe("session-1");
  });
});

// ===========================================================================
// createEnv
// ===========================================================================
describe("createEnv", () => {
  it("sends POST to /api/envs with name and variables", async () => {
    const envData = { name: "Prod", slug: "prod", variables: { KEY: "val" }, createdAt: 1, updatedAt: 1 };
    mockFetch.mockResolvedValueOnce(mockResponse(envData));

    const result = await api.createEnv("Prod", { KEY: "val" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/envs");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "Prod", variables: { KEY: "val" } });
    expect(result).toEqual(envData);
  });
});

// ===========================================================================
// updateEnv
// ===========================================================================
describe("updateEnv", () => {
  it("sends PUT to /api/envs/:slug with data", async () => {
    const envData = { name: "Renamed", slug: "renamed", variables: {}, createdAt: 1, updatedAt: 2 };
    mockFetch.mockResolvedValueOnce(mockResponse(envData));

    await api.updateEnv("my-env", { name: "Renamed" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/envs/${encodeURIComponent("my-env")}`);
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ name: "Renamed" });
  });
});

// ===========================================================================
// settings
// ===========================================================================
describe("settings", () => {
  it("sends GET to /api/settings", async () => {
    const settings = { serverName: "", serverId: "test-id" };
    mockFetch.mockResolvedValueOnce(mockResponse(settings));

    const result = await api.getSettings();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(result).toEqual(settings);
  });

  it("sends PUT to /api/settings", async () => {
    const settings = { serverName: "test", serverId: "test-id" };
    mockFetch.mockResolvedValueOnce(mockResponse(settings));

    await api.updateSettings({ serverName: "test" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ serverName: "test" });
  });

  it("sends heavy repo mode through PUT /api/settings", async () => {
    const settings = { serverName: "", serverId: "test-id", heavyRepoModeEnabled: true };
    mockFetch.mockResolvedValueOnce(mockResponse(settings));

    await api.updateSettings({ heavyRepoModeEnabled: true });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ heavyRepoModeEnabled: true });
  });
});

// ===========================================================================
// getRepoInfo
// ===========================================================================
describe("getRepoInfo", () => {
  it("sends GET with encoded path query param", async () => {
    const info = { repoRoot: "/repo", repoName: "app", currentBranch: "main", defaultBranch: "main" };
    mockFetch.mockResolvedValueOnce(mockResponse(info));

    const result = await api.getRepoInfo("/path/to repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/git/repo-info?path=${encodeURIComponent("/path/to repo")}`);
    expect(result).toEqual(info);
  });
});

// ===========================================================================
// getFileDiff
// ===========================================================================
describe("getFileDiff", () => {
  it("sends GET with encoded path query param", async () => {
    const diffData = { path: "/repo/file.ts", diff: "+new line\n-old line" };
    mockFetch.mockResolvedValueOnce(mockResponse(diffData));

    const result = await api.getFileDiff("/repo/file.ts");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/diff?path=${encodeURIComponent("/repo/file.ts")}`);
    expect(result).toEqual(diffData);
  });

  it("supports base branch and includeContents query options", async () => {
    const diffData = { path: "/repo/file.ts", diff: "+new line\n-old line", oldText: "old", newText: "new" };
    mockFetch.mockResolvedValueOnce(mockResponse(diffData));

    const result = await api.getFileDiff("/repo/file.ts", "main", { includeContents: true });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/diff?path=${encodeURIComponent("/repo/file.ts")}&base=main&includeContents=1`);
    expect(result).toEqual(diffData);
  });

  it("includes sessionId when provided for session-anchored diffs", async () => {
    const diffData = { path: "/repo/file.ts", diff: "+new line\n-old line" };
    mockFetch.mockResolvedValueOnce(mockResponse(diffData));

    const result = await api.getFileDiff("/repo/file.ts", "main", { sessionId: "sess-1" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/diff?path=${encodeURIComponent("/repo/file.ts")}&base=main&sessionId=sess-1`);
    expect(result).toEqual(diffData);
  });
});

// ===========================================================================
// getSessionUsageLimits
// ===========================================================================
describe("getSessionUsageLimits", () => {
  it("sends GET to /api/sessions/:id/usage-limits", async () => {
    const limitsData = {
      five_hour: { utilization: 25, resets_at: "2026-01-01T12:00:00Z" },
      seven_day: null,
      extra_usage: null,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(limitsData));

    const result = await api.getSessionUsageLimits("sess-123");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-123/usage-limits");
    expect(result).toEqual(limitsData);
  });
});

// ===========================================================================
// getCloudProviderPlan
// ===========================================================================
describe("getCloudProviderPlan", () => {
  it("sends GET with provider/cwd/sessionId query params", async () => {
    const plan = {
      provider: "modal",
      sessionId: "s1",
      image: "companion-core:latest",
      cwd: "/repo",
      mappedPorts: [{ containerPort: 3000, hostPort: 49152 }],
      commandPreview: "modal run companion_cloud.py --manifest /repo/.companion/cloud/environments/s1.json",
    };
    mockFetch.mockResolvedValueOnce(mockResponse(plan));

    const result = await api.getCloudProviderPlan("modal", "/repo", "s1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `/api/cloud/providers/modal/plan?cwd=${encodeURIComponent("/repo")}&sessionId=${encodeURIComponent("s1")}`,
    );
    expect(result).toEqual(plan);
  });
});
