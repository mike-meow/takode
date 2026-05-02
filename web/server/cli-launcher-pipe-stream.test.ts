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
});
