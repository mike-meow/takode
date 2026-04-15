// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = {
  getLogs: vi.fn(),
  listSessions: vi.fn(),
  buildLogStreamUrl: vi.fn((_query?: unknown) => "/api/logs/stream?tail=0"),
};

vi.mock("../api.js", () => ({
  api: {
    getLogs: (query?: unknown) => mockApi.getLogs(query),
    listSessions: () => mockApi.listSessions(),
  },
  buildLogStreamUrl: (query?: unknown) => mockApi.buildLogStreamUrl(query),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Array<(event: Event | MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event | MessageEvent<string>) => void) {
    const current = this.listeners.get(type) || [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: string, data?: unknown) {
    const listeners = this.listeners.get(type) || [];
    const event =
      typeof data === "undefined"
        ? new Event(type)
        : ({
            data: JSON.stringify(data),
          } as MessageEvent<string>);
    for (const listener of listeners) listener(event);
  }

  close() {}
}

vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);

import { LogsPage } from "./LogsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.instances = [];
  window.location.hash = "#/logs";
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  mockApi.getLogs.mockResolvedValue({
    entries: [
      {
        ts: 1_700_000_000_000,
        isoTime: "2024-11-14T22:13:20.000Z",
        level: "info",
        component: "server",
        message: "Started",
        pid: 123,
        seq: 1,
      },
    ],
    availableComponents: ["server", "ws-bridge"],
    logFile: "/tmp/server-3456.jsonl",
  });
  mockApi.listSessions.mockResolvedValue([
    { sessionId: "session-468", sessionNum: 468, createdAt: 1 },
    { sessionId: "session-7", sessionNum: 7, createdAt: 1 },
  ]);
});

describe("LogsPage", () => {
  it("loads logs and renders the current entries", async () => {
    // The page should validate the query via REST, then hydrate visible entries from the atomic stream snapshot.
    render(<LogsPage />);

    expect(mockApi.getLogs).toHaveBeenCalledWith({
      levels: undefined,
      components: undefined,
      pattern: undefined,
      regex: true,
      limit: 500,
    });

    const stream = MockEventSource.instances[0];
    stream.emit("entry", {
      ts: 1_700_000_000_000,
      isoTime: "2024-11-14T22:13:20.000Z",
      level: "info",
      component: "server",
      message: "Started",
      pid: 123,
      seq: 1,
    });
    stream.emit("ready", {
      ok: true,
      availableComponents: ["server", "ws-bridge"],
      logFile: "/tmp/server-3456.jsonl",
    });

    expect(await screen.findByText("Started")).toBeInTheDocument();
    expect(screen.getByText("/tmp/server-3456.jsonl")).toBeInTheDocument();
    expect(screen.getByLabelText("Message Filter")).toBeInTheDocument();
  });

  it("shows mobile filter controls collapsed by default", async () => {
    // On mobile, the filters should collapse so the log feed gets most of the vertical space.
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    render(<LogsPage />);

    expect(screen.getByText("Show Filters")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message Filter")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Show Filters"));
    expect(await screen.findByLabelText("Message Filter")).toBeInTheDocument();
  });

  it("appends streamed entries and navigates back to settings", async () => {
    // Live entries should append after the initial stream is ready, and the page should preserve navigation back to Settings.
    render(<LogsPage />);

    const stream = MockEventSource.instances[0];
    stream.emit("entry", {
      ts: 1_700_000_000_000,
      isoTime: "2024-11-14T22:13:20.000Z",
      level: "info",
      component: "server",
      message: "Started",
      pid: 123,
      seq: 1,
    });
    stream.emit("ready", {
      ok: true,
      availableComponents: ["server", "ws-bridge"],
      logFile: "/tmp/server-3456.jsonl",
    });
    await screen.findByText("Started");

    stream.emit("entry", {
      ts: 1_700_000_001_000,
      isoTime: "2024-11-14T22:13:21.000Z",
      level: "error",
      component: "ws-bridge",
      message: "Reconnect failed",
      pid: 123,
      seq: 2,
    });

    await waitFor(() => {
      expect(screen.getByText("Reconnect failed")).toBeInTheDocument();
      expect(screen.getByText("Live")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Back"));
    expect(window.location.hash).toBe("#/settings");
  });

  it("renders session-backed component and metadata labels with session numbers", async () => {
    // Human-readable session numbers should replace raw session UUIDs in the visible log labels.
    render(<LogsPage />);
    const stream = MockEventSource.instances[0];
    stream.emit("entry", {
      ts: 1_700_000_001_000,
      isoTime: "2024-11-14T22:13:21.000Z",
      level: "error",
      component: "session:session-468:stderr",
      message: "Reconnect failed",
      sessionId: "session-7",
      pid: 123,
      seq: 2,
    });
    stream.emit("ready", {
      ok: true,
      availableComponents: ["session:session-468:stderr"],
      logFile: "/tmp/server-3456.jsonl",
    });

    expect(await screen.findByText("session:#468:stderr")).toBeInTheDocument();
    expect(screen.getByText("session=#7")).toBeInTheDocument();
  });

  it("rewires queries when filters change and surfaces offline stream state", async () => {
    // Changing the regex toggle and component filter should rebuild both REST and stream queries,
    // and stream failures should be visible to the operator.
    render(<LogsPage />);

    const stream = MockEventSource.instances[0];
    stream.emit("ready", {
      ok: true,
      availableComponents: ["server", "ws-bridge"],
      logFile: "/tmp/server-3456.jsonl",
    });
    await screen.findByText("/tmp/server-3456.jsonl");

    fireEvent.click(screen.getByLabelText("Treat pattern as regex"));
    await waitFor(() => {
      expect(mockApi.getLogs).toHaveBeenLastCalledWith({
        levels: undefined,
        components: undefined,
        pattern: undefined,
        regex: false,
        limit: 500,
      });
      expect(mockApi.buildLogStreamUrl).toHaveBeenLastCalledWith({
        levels: undefined,
        components: undefined,
        pattern: undefined,
        regex: false,
        tail: 500,
      });
    });

    fireEvent.click(screen.getByLabelText("server"));
    await waitFor(() => {
      expect(mockApi.getLogs).toHaveBeenLastCalledWith({
        levels: undefined,
        components: ["ws-bridge"],
        pattern: undefined,
        regex: false,
        limit: 500,
      });
    });

    const nextStream = MockEventSource.instances.at(-1)!;
    nextStream.onerror?.(new Event("error"));
    await waitFor(() => {
      expect(screen.getByText("Offline")).toBeInTheDocument();
    });
  });

  it("shows regex validation errors returned by the server", async () => {
    // Invalid regex input should surface a real error instead of looking like an empty result set.
    render(<LogsPage />);
    const stream = MockEventSource.instances[0];
    stream.emit("ready", {
      ok: true,
      availableComponents: ["server"],
      logFile: "/tmp/server-3456.jsonl",
    });
    await screen.findByText("/tmp/server-3456.jsonl");

    mockApi.getLogs.mockRejectedValueOnce(new Error("Invalid log regex: ("));
    fireEvent.change(screen.getByLabelText("Message Filter"), { target: { value: "(" } });

    await waitFor(() => {
      expect(screen.getByText("Invalid log regex: (")).toBeInTheDocument();
    });
  });

  it("pauses auto-follow when the feed is scrolled away from the bottom and resumes on demand", async () => {
    // Operators need to inspect older logs without losing the ability to jump back to the live tail.
    render(<LogsPage />);
    const stream = MockEventSource.instances[0];
    stream.emit("entry", {
      ts: 1_700_000_000_000,
      isoTime: "2024-11-14T22:13:20.000Z",
      level: "info",
      component: "server",
      message: "Started",
      pid: 123,
      seq: 1,
    });
    stream.emit("ready", {
      ok: true,
      availableComponents: ["server"],
      logFile: "/tmp/server-3456.jsonl",
    });
    await screen.findByText("Started");

    const feed = screen.getByTestId("logs-feed");
    Object.defineProperty(feed, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(feed, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(feed, "scrollTop", { configurable: true, writable: true, value: 0 });

    fireEvent.scroll(feed);
    expect(screen.getByText("Auto-scroll paused")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Jump to live"));
    expect((feed as HTMLElement).scrollTop).toBe(500);
    expect(screen.getByText("Following live tail")).toBeInTheDocument();
  });
});
