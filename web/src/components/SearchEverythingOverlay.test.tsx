// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SearchEverythingOverlay } from "./SearchEverythingOverlay.js";
import type { SearchEverythingResponse, SearchEverythingResult } from "../api.js";
import { searchEverything } from "../../server/search-everything.js";

const mocks = vi.hoisted(() => ({
  searchEverything: vi.fn(),
  navigateToSession: vi.fn(),
  navigateToSessionMessageId: vi.fn(),
  withQuestIdInHash: vi.fn((_hash: string, questId: string) => `#/session/s1?quest=${questId}`),
  withThreadKeyInHash: vi.fn((hash: string, threadKey: string) => `${hash}?thread=${threadKey}`),
  openQuestOverlay: vi.fn(),
}));

vi.mock("../api.js", () => ({
  api: {
    searchEverything: (...args: unknown[]) => mocks.searchEverything(...args),
  },
}));

vi.mock("../store.js", () => ({
  useStore: {
    getState: () => ({
      openQuestOverlay: (...args: unknown[]) => mocks.openQuestOverlay(...args),
    }),
  },
}));

vi.mock("../utils/routing.js", () => ({
  navigateToSession: (...args: unknown[]) => mocks.navigateToSession(...args),
  navigateToSessionMessageId: (...args: unknown[]) => mocks.navigateToSessionMessageId(...args),
  withQuestIdInHash: (hash: string, questId: string) => mocks.withQuestIdInHash(hash, questId),
  withThreadKeyInHash: (hash: string, threadKey: string) => mocks.withThreadKeyInHash(hash, threadKey),
}));

function result(overrides: Partial<SearchEverythingResult>): SearchEverythingResult {
  return {
    id: "session:s1",
    type: "session",
    title: "#12 Auth worker",
    subtitle: "last active 3m ago · main · /repo",
    score: 1000,
    matchedFields: ["user_message"],
    childMatches: [
      {
        id: "message:s1:m1",
        type: "message",
        title: "Message",
        snippet: "auth token failed during login",
        matchedField: "user_message",
        score: 660,
        route: { kind: "message", sessionId: "s1", messageId: "m1" },
      },
      {
        id: "message:s1:m2",
        type: "message",
        title: "Assistant",
        snippet: "auth middleware logs updated",
        matchedField: "assistant",
        score: 620,
      },
      {
        id: "message:s1:m3",
        type: "message",
        title: "Message",
        snippet: "auth redirect still fails",
        matchedField: "user_message",
        score: 660,
      },
    ],
    totalChildMatches: 5,
    remainingChildMatches: 2,
    route: { kind: "session", sessionId: "s1" },
    meta: { sessionId: "s1", sessionNum: 12, lastActivityAt: 1000, cwd: "/repo", gitBranch: "main" },
    ...overrides,
  };
}

function response(results: SearchEverythingResult[]): SearchEverythingResponse {
  return { query: "auth", tookMs: 3, totalMatches: results.length, results };
}

async function typeQuery(value: string) {
  fireEvent.change(screen.getByLabelText("Search everything query"), { target: { value } });
  await waitFor(() => expect(mocks.searchEverything).toHaveBeenLastCalledWith(value, expect.any(Object)));
}

function optionByText(pattern: RegExp): HTMLElement {
  const option = screen.getAllByRole("option").find((candidate) => pattern.test(candidate.textContent ?? ""));
  if (!option) {
    throw new Error(`No option matched ${pattern}`);
  }
  return option;
}

describe("SearchEverythingOverlay", () => {
  beforeEach(() => {
    mocks.searchEverything.mockReset();
    mocks.navigateToSession.mockReset();
    mocks.navigateToSessionMessageId.mockReset();
    mocks.openQuestOverlay.mockReset();
    window.location.hash = "#/session/s1";
  });

  it("searches app-wide active categories and renders grouped child snippets", async () => {
    mocks.searchEverything.mockResolvedValue(response([result({})]));

    render(<SearchEverythingOverlay open currentSessionId="s1" onClose={() => undefined} />);
    await typeQuery("auth");

    const row = optionByText(/Auth\s*worker/i);
    expect(mocks.searchEverything).toHaveBeenCalledWith(
      "auth",
      expect.objectContaining({
        types: ["quests", "sessions", "messages"],
        currentSessionId: "s1",
        includeArchived: false,
        includeReviewers: false,
        childPreviewLimit: 3,
      }),
    );
    expect(within(row).getByText("5 matches")).toBeInTheDocument();
    expect(within(row).getByText("+2 more matches")).toBeInTheDocument();
    expect(within(row).getByText(/token failed/i)).toBeInTheDocument();
  });

  it("supports category toggles without allowing all categories to be disabled", async () => {
    mocks.searchEverything.mockResolvedValue(response([]));

    render(<SearchEverythingOverlay open currentSessionId={null} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Quests" }));
    await typeQuery("auth");

    expect(mocks.searchEverything).toHaveBeenLastCalledWith(
      "auth",
      expect.objectContaining({ types: ["sessions", "messages"] }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Messages" }));
    await typeQuery("auth logs");

    expect(mocks.searchEverything).toHaveBeenLastCalledWith(
      "auth logs",
      expect.objectContaining({ types: ["messages"] }),
    );
  });

  it("navigates with keyboard selection and closes", async () => {
    const onClose = vi.fn();
    mocks.searchEverything.mockResolvedValue(
      response([
        result({ id: "session:s1", route: { kind: "session", sessionId: "s1" } }),
        result({ id: "session:s2", title: "#13 Deploy worker", route: { kind: "session", sessionId: "s2" } }),
      ]),
    );

    render(<SearchEverythingOverlay open currentSessionId="s1" onClose={onClose} />);
    await typeQuery("worker");
    expect(optionByText(/Deploy\s*worker/i)).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(mocks.navigateToSession).toHaveBeenCalledWith("s2");
    expect(onClose).toHaveBeenCalled();
  });

  it("routes quest results and backend-produced grouped message results to existing deep-link helpers", async () => {
    const quest = result({
      id: "quest:q-42",
      type: "quest",
      title: "q-42 Search overlay",
      route: { kind: "quest", questId: "q-42" },
      meta: { questId: "q-42" },
    });
    const groupedMessage = searchEverything(
      [],
      [
        {
          sessionId: "s3",
          sessionNum: 33,
          archived: false,
          createdAt: 100,
          name: "Threaded session",
          messageHistory: [
            { type: "user_message", id: "m1", content: "older threaded note", timestamp: 100, threadKey: "q-1" },
            { type: "user_message", id: "m9", content: "threaded search target", timestamp: 300, threadKey: "q-42" },
          ],
        },
      ],
      { query: "threaded", categories: ["messages"], childPreviewLimit: 3 },
    ).results[0] as SearchEverythingResult;
    mocks.searchEverything.mockResolvedValue(response([quest]));

    const { unmount } = render(<SearchEverythingOverlay open currentSessionId="s1" onClose={() => undefined} />);
    await typeQuery("search");
    fireEvent.click(optionByText(/Search\s*overlay/i));

    expect(mocks.openQuestOverlay).toHaveBeenCalledWith("q-42");
    unmount();

    render(<SearchEverythingOverlay open currentSessionId="s1" onClose={() => undefined} />);
    mocks.searchEverything.mockResolvedValue(response([groupedMessage]));
    await typeQuery("threaded");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(mocks.navigateToSessionMessageId).toHaveBeenCalledWith("s3", "m9", {
      routeSessionId: 33,
      threadKey: "q-42",
    });
  });

  it("shows loading, empty, error, and Escape states", async () => {
    const onClose = vi.fn();
    let resolveSearch: (value: SearchEverythingResponse) => void = () => undefined;
    mocks.searchEverything.mockReturnValue(new Promise((resolve) => (resolveSearch = resolve)));

    const { rerender } = render(<SearchEverythingOverlay open currentSessionId={null} onClose={onClose} />);
    await typeQuery("slow");
    expect(screen.getAllByText("Searching")).toHaveLength(2);

    await act(async () => resolveSearch(response([])));
    expect(await screen.findByText("No results")).toBeInTheDocument();

    mocks.searchEverything.mockRejectedValue(new Error("route failed"));
    await typeQuery("broken");
    expect(await screen.findByText("Search failed")).toBeInTheDocument();
    expect(screen.getByText("route failed")).toBeInTheDocument();

    rerender(<SearchEverythingOverlay open currentSessionId={null} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
