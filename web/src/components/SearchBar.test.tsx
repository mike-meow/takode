// @vitest-environment jsdom
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar.js";
import { useStore } from "../store.js";

const SESSION_ID = "search-bar-test";
const requestScrollToMessage = vi.fn();

function setSearchState(
  overrides: Partial<
    ReturnType<typeof useStore.getState>["sessionSearch"] extends Map<string, infer T> ? T : never
  > = {},
) {
  useStore.setState({
    sessionSearch: new Map([
      [
        SESSION_ID,
        {
          query: "hello",
          isOpen: true,
          mode: "strict",
          category: "all",
          matches: [{ messageId: "m1" }, { messageId: "m2" }],
          currentMatchIndex: 0,
          ...overrides,
        },
      ],
    ]),
  });
}

describe("SearchBar", () => {
  beforeEach(() => {
    // Keep the store local to this component test so category toggles do not
    // leak into unrelated suites that also rely on the singleton Zustand store.
    requestScrollToMessage.mockReset();
    useStore.setState({
      sessionSearch: new Map(),
      messages: new Map([
        [
          SESSION_ID,
          [
            { id: "m1", role: "user", content: "hello from user", timestamp: 1 },
            { id: "m2", role: "assistant", content: "hello from assistant", timestamp: 2 },
            {
              id: "m3",
              role: "user",
              content: "hello from timer",
              timestamp: 3,
              agentSource: { sessionId: "timer:t1" },
            },
            { id: "m4", role: "system", content: "hello from system", timestamp: 4 },
          ],
        ],
      ]),
      requestScrollToMessage,
    });
    setSearchState({
      matches: [{ messageId: "m1" }, { messageId: "m2" }, { messageId: "m3" }],
      currentMatchIndex: 2,
    });
  });

  it("renders inline message-category filters", () => {
    render(<SearchBar sessionId={SESSION_ID} inputRef={createRef<HTMLInputElement>()} />);

    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "User" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assistant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Events" })).toBeInTheDocument();
  });

  it("updates the active category when a filter pill is clicked", () => {
    render(<SearchBar sessionId={SESSION_ID} inputRef={createRef<HTMLInputElement>()} />);

    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));

    const nextState = useStore.getState().sessionSearch.get(SESSION_ID);
    expect(nextState?.category).toBe("assistant");
    expect(screen.getByRole("button", { name: "Assistant" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });

  it("immediately resets the counter and Enter navigation to the filtered results", () => {
    render(<SearchBar sessionId={SESSION_ID} inputRef={createRef<HTMLInputElement>()} />);

    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));

    const nextState = useStore.getState().sessionSearch.get(SESSION_ID);
    expect(nextState?.matches).toEqual([{ messageId: "m2" }]);
    expect(nextState?.currentMatchIndex).toBe(0);
    expect(screen.getByText("1 of 1")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByPlaceholderText("Search messages..."), { key: "Enter" });

    expect(requestScrollToMessage).toHaveBeenLastCalledWith(SESSION_ID, "m2");
  });

  it("treats timer-style injected user messages as events when that filter is selected", () => {
    render(<SearchBar sessionId={SESSION_ID} inputRef={createRef<HTMLInputElement>()} />);

    fireEvent.click(screen.getByRole("button", { name: "Events" }));

    const nextState = useStore.getState().sessionSearch.get(SESSION_ID);
    expect(nextState?.category).toBe("event");
    expect(nextState?.matches).toEqual([{ messageId: "m3" }, { messageId: "m4" }]);
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });
});
