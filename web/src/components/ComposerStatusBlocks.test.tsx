// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerStatusBlocks } from "./ComposerStatusBlocks.js";

let mockAbsolutePath = "/workspace/project/web/src/components/Composer.tsx";

vi.mock("../store.js", () => ({
  useStore: <T,>(selector: (state: { vscodeSelectionContext: { selection: { absolutePath: string } } }) => T) =>
    selector({
      vscodeSelectionContext: {
        selection: {
          absolutePath: mockAbsolutePath,
        },
      },
    }),
}));

function renderStatusBlocks(overrides: Partial<Parameters<typeof ComposerStatusBlocks>[0]> = {}) {
  const props: Parameters<typeof ComposerStatusBlocks>[0] = {
    isPreparing: false,
    isRecording: false,
    isTranscribing: false,
    transcriptionPhase: null,
    volumeLevel: 0,
    volumeHistory: [],
    voiceCaptureMode: "dictation",
    voiceUnsupportedInfoOpen: false,
    voiceUnsupportedMessage: null,
    voiceError: null,
    failedTranscription: null,
    voiceEditProposal: null,
    replyContext: null,
    vscodeSelectionLabel: "Composer.tsx:12-14",
    vscodeSelectionSummary: "3 lines selected",
    vscodeSelectionTitle: "[user selection in VSCode: web/src/components/Composer.tsx lines 12-14]",
    onRetryTranscription: vi.fn(),
    onDismissVoiceError: vi.fn(),
    onAcceptVoiceEdit: vi.fn(),
    onUndoVoiceEdit: vi.fn(),
    onDismissUnsupportedInfo: vi.fn(),
    onDismissReply: vi.fn(),
    onDismissVsCodeSelection: vi.fn(),
    onSetVoiceModeEdit: vi.fn(),
    onSetVoiceModeAppend: vi.fn(),
    ...overrides,
  };

  render(<ComposerStatusBlocks {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  mockAbsolutePath = "/workspace/project/web/src/components/Composer.tsx";
  vi.clearAllMocks();
});

describe("ComposerStatusBlocks voice recording controls", () => {
  it("shows the edit/append selector immediately before the recording label and wires both actions", async () => {
    // q-453: the current voice mode needs to be visible next to the active
    // recording label so users can catch edit-vs-append mistakes before speaking.
    const props = renderStatusBlocks({
      isRecording: true,
      voiceCaptureMode: "edit",
      vscodeSelectionLabel: null,
      vscodeSelectionSummary: null,
      vscodeSelectionTitle: null,
    });

    const modeToggle = screen.getByTestId("voice-capture-mode-toggle");
    const recordingLabel = screen.getByText("Recording");
    expect(modeToggle.compareDocumentPosition(recordingLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Append" }));

    expect(props.onSetVoiceModeEdit).toHaveBeenCalledTimes(1);
    expect(props.onSetVoiceModeAppend).toHaveBeenCalledTimes(1);
  });

  it("renders one fixed waveform meter with the current level as the newest sample", () => {
    // The recording row uses one centered waveform surface so the live level
    // and recent history read as a single compact meter.
    renderStatusBlocks({
      isRecording: true,
      volumeLevel: 0.7,
      volumeHistory: [
        { time: 0, level: 0.08 },
        { time: 125, level: 0.35 },
        { time: 250, level: 0.72 },
      ],
      vscodeSelectionLabel: null,
      vscodeSelectionSummary: null,
      vscodeSelectionTitle: null,
    });

    expect(screen.queryByLabelText("Current input level")).toBeNull();
    expect(screen.queryByLabelText("Recent input level history")).toBeNull();

    const waveform = screen.getByLabelText("Current and recent input level");
    expect(waveform.className).toContain("items-center");
    expect(waveform.className).toContain("shrink-0");

    const bars = screen.getAllByTestId("voice-level-waveform-bar");
    expect(bars).toHaveLength(40);
    expect(bars[bars.length - 1].getAttribute("data-current-sample")).toBe("true");
    expect(bars[bars.length - 1].getAttribute("data-clipping")).toBeNull();
  });

  it("reserves red waveform bars for clipping-level input", () => {
    // Healthy recording levels stay in the normal copper meter; only an
    // overload-level current sample should trip the clipping marker.
    renderStatusBlocks({
      isRecording: true,
      volumeLevel: 0.99,
      volumeHistory: [
        { time: 0, level: 0.2 },
        { time: 125, level: 0.45 },
      ],
      vscodeSelectionLabel: null,
      vscodeSelectionSummary: null,
      vscodeSelectionTitle: null,
    });

    const bars = screen.getAllByTestId("voice-level-waveform-bar");
    expect(bars[bars.length - 1].getAttribute("data-current-sample")).toBe("true");
    expect(bars[bars.length - 1].getAttribute("data-clipping")).toBe("true");
  });

  it("labels post-STT no-enhancement transcription as finalizing", () => {
    renderStatusBlocks({
      isTranscribing: true,
      transcriptionPhase: "finalizing",
      vscodeSelectionLabel: null,
      vscodeSelectionSummary: null,
      vscodeSelectionTitle: null,
    });

    expect(screen.getByText("Finalizing...")).toBeTruthy();
    expect(screen.queryByText("Transcribing...")).toBeNull();
  });
});

describe("ComposerStatusBlocks VS Code selection chip", () => {
  it("keeps the chip label compact while showing the full path on hover", async () => {
    // Regression coverage for long paths: the visible label should be the basename/range
    // and the full absolute path should live in the popover, not in the chip body.
    mockAbsolutePath = "/test/project-b/users/jiayi/really/long/path/to/OverflowTarget.tsx";
    renderStatusBlocks({
      vscodeSelectionLabel: "OverflowTarget.tsx:7-9",
      vscodeSelectionSummary: "3 lines selected",
    });

    expect(screen.getByText("OverflowTarget.tsx:7-9")).toBeTruthy();
    expect(screen.queryByText(mockAbsolutePath)).toBeNull();

    await userEvent.hover(screen.getByTestId("vscode-selection-path-trigger"));

    expect(screen.getByTestId("vscode-selection-path-popover").textContent).toContain(mockAbsolutePath);
  });

  it("opens the full path on tap and keeps the dismiss button reachable", async () => {
    // Mobile taps should use the same popover content while the clear affordance remains
    // a separate shrink-0 control so long filenames cannot push it off screen.
    const props = renderStatusBlocks();

    await userEvent.click(screen.getByTestId("vscode-selection-path-trigger"));

    expect(screen.getByTestId("vscode-selection-path-popover").textContent).toContain(mockAbsolutePath);
    expect(screen.getByTestId("vscode-selection-dismiss").className).toContain("shrink-0");

    await userEvent.click(screen.getByTestId("vscode-selection-dismiss"));
    expect(props.onDismissVsCodeSelection).toHaveBeenCalledTimes(1);
  });
});
