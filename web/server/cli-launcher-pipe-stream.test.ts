import { describe, expect, it, vi } from "vitest";
import { CliLauncher } from "./cli-launcher.js";

type PipeStreamForTest = (
  sessionId: string,
  stream: ReadableStream<Uint8Array> | null,
  label: "stdout" | "stderr",
  tailLines?: string[],
  onText?: (text: string) => void,
) => Promise<void>;

describe("CliLauncher pipeStream", () => {
  it("forwards stderr chunks to the supplied text handler while preserving logging and tail capture", async () => {
    // q-1073 feedback #6: Codex write_stdin router failures can be emitted only
    // on process stderr. The launcher must keep logging stderr, but also hand
    // the raw chunk to the Codex adapter for narrow failed-tool synthesis.
    const launcher = new CliLauncher(3456, { serverId: "test-server-id" });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onText = vi.fn();
    const tailLines: string[] = [];
    const stderrLine =
      "2026-05-02T19:19:37.348471Z ERROR codex_core::tools::router: " +
      "error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderrLine));
        controller.close();
      },
    });

    const pipeStream = (launcher as unknown as { pipeStream: PipeStreamForTest }).pipeStream.bind(launcher);
    await pipeStream("test-session-id", stream, "stderr", tailLines, onText);

    expect(onText).toHaveBeenCalledWith(stderrLine);
    expect(tailLines.join("\n")).toContain("write_stdin failed: stdin is closed");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("write_stdin failed: stdin is closed"));
    stderrSpy.mockRestore();
  });

  it("classifies and dedupes repeated Codex missing custom tool-output stderr", async () => {
    // A persisted Codex CustomToolCall orphan can repeat on stderr while the
    // session continues. Keep one classified diagnostic with raw evidence and
    // suppress identical call-id repeats.
    const launcher = new CliLauncher(3456, { serverId: "test-server-id" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const callId = "call_B2StgCHbFi7KjujPrAjvrZko";
    const stderrLine = `2026-05-17T23:21:18.332Z ERROR codex_core::context_manager::normalize: Custom tool call output is missing for call id: ${callId}\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderrLine));
        controller.enqueue(new TextEncoder().encode(stderrLine));
        controller.close();
      },
    });

    const pipeStream = (launcher as unknown as { pipeStream: PipeStreamForTest }).pipeStream.bind(launcher);
    await pipeStream("test-session-id", stream, "stderr");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("codex-canonical-history-orphan"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("session_id=test-session-id"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`call_id=${callId}`));
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("keeps new Codex missing tool-output evidence from multi-call chunks", async () => {
    const launcher = new CliLauncher(3456, { serverId: "test-server-id" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const firstCall = "call_first";
    const secondCall = "call_second";
    const firstLine = `ERROR codex_core::context_manager::normalize: Custom tool call output is missing for call id: ${firstCall}\n`;
    const combinedChunk = [
      `ERROR codex_core::context_manager::normalize: Custom tool call output is missing for call id: ${firstCall}`,
      `ERROR codex_core::context_manager::normalize: Custom tool call output is missing for call id: ${secondCall}`,
      "",
    ].join("\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstLine));
        controller.enqueue(new TextEncoder().encode(combinedChunk));
        controller.close();
      },
    });

    const pipeStream = (launcher as unknown as { pipeStream: PipeStreamForTest }).pipeStream.bind(launcher);
    await pipeStream("test-session-id-multi-call", stream, "stderr");

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`call_id=${firstCall}`));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`call_id=${secondCall}`));
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
