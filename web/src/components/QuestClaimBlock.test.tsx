// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import { QuestClaimBlock } from "./QuestClaimBlock.js";

describe("QuestClaimBlock", () => {
  it("uses shared quest status colors for the status badge", () => {
    render(
      <QuestClaimBlock
        quest={{
          questId: "q-77",
          title: "Palette test",
          status: "in_progress",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Quest Claimed/i }));
    const inProgressBadge = screen.getByText("In Progress");
    expect(inProgressBadge).toHaveClass("text-green-400");
  });

  it("opens local details modal and keeps quest link scoped to the same id", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    const dialog = screen.getByRole("dialog", { name: /Quest details: Dummy quest/i });
    expect(dialog).toBeInTheDocument();
    const viewLink = within(dialog).getByRole("link", { name: "Open in Questmaster" });
    expect(viewLink).toHaveAttribute("href", "#/questmaster?quest=q-76");
  });

  it("opens quest thumbnails in the shared lightbox overlay", () => {
    render(
      <QuestClaimBlock
        quest={{
          questId: "q-75",
          title: "Image quest",
          status: "needs_verification",
          images: [{ id: "img-1", filename: "preview.png", mimeType: "image/png", path: "/tmp/preview.png" }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Quest Claimed/i }));
    fireEvent.click(screen.getByAltText("preview.png"));

    expect(screen.getByTestId("lightbox-image")).toHaveAttribute("src", "/api/quests/_images/img-1");
  });
});
