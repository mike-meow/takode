// @vitest-environment jsdom
import {
  getUiTraceSnapshot,
  installUiCrashDebugHooks,
  recordUiTrace,
  resetUiCrashDebugForTest,
} from "./ui-crash-debug.js";

describe("ui-crash-debug", () => {
  beforeEach(() => {
    resetUiCrashDebugForTest();
  });

  it("records trace entries only when debug flag is enabled", () => {
    recordUiTrace("event.disabled", { value: 1 });
    expect(getUiTraceSnapshot()).toHaveLength(0);

    localStorage.setItem("cc-debug-ui-crash", "1");
    recordUiTrace("event.enabled", { value: 2 });
    const trace = getUiTraceSnapshot();
    expect(trace).toHaveLength(1);
    expect(trace[0]?.event).toBe("event.enabled");
    expect(trace[0]?.details).toContain("\"value\":2");
  });

  it("keeps a bounded ring buffer", () => {
    localStorage.setItem("cc-debug-ui-crash", "1");
    for (let i = 0; i < 220; i++) {
      recordUiTrace(`event.${i}`);
    }
    const trace = getUiTraceSnapshot();
    expect(trace).toHaveLength(200);
    expect(trace[0]?.event).toBe("event.20");
    expect(trace[199]?.event).toBe("event.219");
  });

  it("installs global error hooks and captures window errors", () => {
    localStorage.setItem("cc-debug-ui-crash", "1");
    installUiCrashDebugHooks();
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "app.js", lineno: 12, colno: 7 }));
    const trace = getUiTraceSnapshot();
    expect(trace.some((t) => t.event === "window.error" && t.details.includes("boom"))).toBe(true);
  });
});

