// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import { QuestClaimBlock } from "./QuestClaimBlock.js";

describe("QuestClaimBlock", () => {
  it("links View in Questmaster to the specific quest id", () => {
    render(
      <QuestClaimBlock
        quest={{
          questId: "q-76",
          title: "Dummy quest",
          status: "in_progress",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Quest Claimed/i }));

    const viewLink = screen.getByRole("link", { name: "View in Questmaster" });
    expect(viewLink).toHaveAttribute("href", "#/questmaster?quest=q-76");
  });
});
