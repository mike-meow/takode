import { describe, expect, it } from "vitest";
import type { BufferedBrowserEvent } from "../session-types.js";
import { createSyntheticLargeLeaderReplayFixture } from "../../src/test-fixtures/large-leader-feed-fixture.js";
import { isReplayableBufferedEvent } from "./replay-buffer-policy.js";

function replayableLeaderEvents(events: BufferedBrowserEvent[]): BufferedBrowserEvent[] {
  return events.filter((event) => isReplayableBufferedEvent(event, { isLeaderSession: true }));
}

function isTopLevelTextDelta(event: BufferedBrowserEvent): boolean {
  const message = event.message;
  if (message.type !== "stream_event" || message.parent_tool_use_id !== null) return false;
  const streamEvent = message.event as { type?: unknown; delta?: { type?: unknown; text?: unknown } } | null;
  return (
    streamEvent?.type === "content_block_delta" &&
    streamEvent.delta?.type === "text_delta" &&
    typeof streamEvent.delta.text === "string"
  );
}

describe("large leader replay buffer budgets", () => {
  it("drops high-volume top-level leader text deltas while preserving durable and nested replay events", () => {
    const fixture = createSyntheticLargeLeaderReplayFixture();

    const replayable = replayableLeaderEvents(fixture.events);

    expect(fixture.events).toHaveLength(
      fixture.topLevelLeaderTextDeltaCount +
        fixture.nestedTextDeltaCount +
        fixture.nonTextLeaderStreamEventCount +
        fixture.durableEventCount,
    );
    expect(replayable).toHaveLength(
      fixture.nestedTextDeltaCount + fixture.nonTextLeaderStreamEventCount + fixture.durableEventCount,
    );
    expect(replayable.length).toBeLessThanOrEqual(50);
    expect(replayable.some(isTopLevelTextDelta)).toBe(false);
    expect(replayable.some((event) => event.message.type === "status_change")).toBe(true);
    expect(
      replayable.some((event) => event.message.type === "stream_event" && event.message.parent_tool_use_id !== null),
    ).toBe(true);
  });

  it("does not apply leader-only replay pruning to worker sessions", () => {
    const fixture = createSyntheticLargeLeaderReplayFixture();

    const replayable = fixture.events.filter((event) => isReplayableBufferedEvent(event, { isLeaderSession: false }));

    expect(replayable).toHaveLength(fixture.events.length);
    expect(replayable.filter(isTopLevelTextDelta)).toHaveLength(fixture.topLevelLeaderTextDeltaCount);
  });
});
