const DEBUG_KEY = "cc-debug-ui-crash";
const TRACE_LIMIT = 200;
const TRACE_WINDOW_KEY = "__CC_UI_CRASH_TRACE__";

interface TraceEntry {
  ts: number;
  event: string;
  details: string;
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function isUiCrashDebugEnabled(): boolean {
  if (!hasWindow()) return false;
  try {
    return localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

function stringifyDetails(details: unknown): string {
  if (details === undefined) return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function getTraceBuffer(): TraceEntry[] {
  if (!hasWindow()) return [];
  const win = window as Window & { [TRACE_WINDOW_KEY]?: TraceEntry[] };
  if (!Array.isArray(win[TRACE_WINDOW_KEY])) {
    win[TRACE_WINDOW_KEY] = [];
  }
  return win[TRACE_WINDOW_KEY]!;
}

export function recordUiTrace(event: string, details?: unknown): void {
  if (!isUiCrashDebugEnabled()) return;
  const entry: TraceEntry = {
    ts: Date.now(),
    event,
    details: stringifyDetails(details),
  };
  const trace = getTraceBuffer();
  trace.push(entry);
  if (trace.length > TRACE_LIMIT) {
    trace.splice(0, trace.length - TRACE_LIMIT);
  }
  console.debug("[ui-crash-debug]", event, details);
}

export function getUiTraceSnapshot(): TraceEntry[] {
  return getTraceBuffer().slice();
}

let installed = false;

export function installUiCrashDebugHooks(): void {
  if (!hasWindow() || installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    recordUiTrace("window.error", {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    recordUiTrace("window.unhandledrejection", {
      reason: stringifyDetails(event.reason),
    });
  });

  recordUiTrace("debug.hooks_installed", { href: window.location.href });
}

export function resetUiCrashDebugForTest(): void {
  installed = false;
  if (!hasWindow()) return;
  const win = window as Window & { [TRACE_WINDOW_KEY]?: TraceEntry[] };
  win[TRACE_WINDOW_KEY] = [];
  try {
    localStorage.removeItem(DEBUG_KEY);
  } catch {
    // no-op in test environments where localStorage is unavailable
  }
}
