import { useEffect, useRef, useState } from "react";
import { api, checkHealth, type ImportStats } from "../api.js";
import { useStore } from "../store.js";
import { NamerDebugPanel } from "./NamerDebugPanel.js";

import { navigateToSession, navigateToMostRecentSession } from "../utils/routing.js";

interface SettingsPageProps {
  embedded?: boolean;
}

export function SettingsPage({ embedded = false }: SettingsPageProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const zoomLevel = useStore((s) => s.zoomLevel);
  const setZoomLevel = useStore((s) => s.setZoomLevel);
  const notificationSound = useStore((s) => s.notificationSound);
  const toggleNotificationSound = useStore((s) => s.toggleNotificationSound);
  const notificationDesktop = useStore((s) => s.notificationDesktop);
  const setNotificationDesktop = useStore((s) => s.setNotificationDesktop);
  const showUsageBars = useStore((s) => s.showUsageBars);
  const toggleShowUsageBars = useStore((s) => s.toggleShowUsageBars);
  const notificationApiAvailable = typeof Notification !== "undefined";

  // CLI binary state
  const [claudeBin, setClaudeBin] = useState("");
  const [codexBin, setCodexBin] = useState("");
  const [binSaving, setBinSaving] = useState(false);
  const [binSaved, setBinSaved] = useState(false);
  const [binError, setBinError] = useState("");
  const [claudeTest, setClaudeTest] = useState<{ ok: boolean; resolvedPath?: string; version?: string; error?: string } | null>(null);
  const [codexTest, setCodexTest] = useState<{ ok: boolean; resolvedPath?: string; version?: string; error?: string } | null>(null);
  const [claudeTesting, setClaudeTesting] = useState(false);
  const [codexTesting, setCodexTesting] = useState(false);

  // Session lifecycle state
  const [maxKeepAlive, setMaxKeepAlive] = useState(0);
  const [lifecycleSaving, setLifecycleSaving] = useState(false);
  const [lifecycleSaved, setLifecycleSaved] = useState(false);
  const [lifecycleError, setLifecycleError] = useState("");

  // Pushover state
  const [poUserKey, setPoUserKey] = useState("");
  const [poApiToken, setPoApiToken] = useState("");
  const [poBaseUrl, setPoBaseUrl] = useState("");
  const [poDelay, setPoDelay] = useState(30);
  const [poEnabled, setPoEnabled] = useState(true);
  const [poConfigured, setPoConfigured] = useState(false);
  const [poSaving, setPoSaving] = useState(false);
  const [poSaved, setPoSaved] = useState(false);
  const [poError, setPoError] = useState("");
  const [poTesting, setPoTesting] = useState(false);
  const [poTestResult, setPoTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // Server restart state
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState("");
  const [restartSupported, setRestartSupported] = useState(true);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const healthTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Session export/import state
  const importInputRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPhase, setImportPhase] = useState<"uploading" | "processing">("uploading");
  const [importPct, setImportPct] = useState(0);
  const [importResult, setImportResult] = useState<ImportStats | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setClaudeBin(s.claudeBinary || "");
        setCodexBin(s.codexBinary || "");
        setMaxKeepAlive(s.maxKeepAlive || 0);
        setPoConfigured(s.pushoverConfigured);
        setPoEnabled(s.pushoverEnabled);
        setPoDelay(s.pushoverDelaySeconds);
        setPoBaseUrl(s.pushoverBaseUrl || "");
        setRestartSupported(s.restartSupported);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function onSavePushover(e: React.FormEvent) {
    e.preventDefault();
    setPoSaving(true);
    setPoError("");
    setPoSaved(false);
    try {
      const payload: Record<string, unknown> = {
        pushoverDelaySeconds: poDelay,
        pushoverEnabled: poEnabled,
        pushoverBaseUrl: poBaseUrl.trim(),
      };
      if (poUserKey.trim()) payload.pushoverUserKey = poUserKey.trim();
      if (poApiToken.trim()) payload.pushoverApiToken = poApiToken.trim();

      const res = await api.updateSettings(payload as Parameters<typeof api.updateSettings>[0]);
      setPoConfigured(res.pushoverConfigured);
      setPoEnabled(res.pushoverEnabled);
      setPoDelay(res.pushoverDelaySeconds);
      setPoBaseUrl(res.pushoverBaseUrl || "");
      setPoUserKey("");
      setPoApiToken("");
      setPoSaved(true);
      setTimeout(() => setPoSaved(false), 1800);
    } catch (err: unknown) {
      setPoError(err instanceof Error ? err.message : String(err));
    } finally {
      setPoSaving(false);
    }
  }

  async function onTestPushover() {
    setPoTesting(true);
    setPoTestResult(null);
    try {
      const res = await api.testPushover();
      setPoTestResult({ ok: res.ok });
    } catch (err: unknown) {
      setPoTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setPoTesting(false);
      setTimeout(() => setPoTestResult(null), 3000);
    }
  }

  async function onSaveBinaries(e: React.FormEvent) {
    e.preventDefault();
    setBinSaving(true);
    setBinError("");
    setBinSaved(false);
    try {
      const res = await api.updateSettings({
        claudeBinary: claudeBin.trim(),
        codexBinary: codexBin.trim(),
      });
      setClaudeBin(res.claudeBinary || "");
      setCodexBin(res.codexBinary || "");
      setBinSaved(true);
      setTimeout(() => setBinSaved(false), 1800);
    } catch (err: unknown) {
      setBinError(err instanceof Error ? err.message : String(err));
    } finally {
      setBinSaving(false);
    }
  }

  async function onTestBinary(which: "claude" | "codex") {
    const binary = which === "claude" ? (claudeBin.trim() || "claude") : (codexBin.trim() || "codex");
    const setTesting = which === "claude" ? setClaudeTesting : setCodexTesting;
    const setResult = which === "claude" ? setClaudeTest : setCodexTest;
    setTesting(true);
    setResult(null);
    try {
      const res = await api.testBinary(binary);
      setResult(res);
    } catch (err: unknown) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
      setTimeout(() => setResult(null), 5000);
    }
  }

  async function onSaveLifecycle(e: React.FormEvent) {
    e.preventDefault();
    setLifecycleSaving(true);
    setLifecycleError("");
    setLifecycleSaved(false);
    try {
      const res = await api.updateSettings({ maxKeepAlive });
      setMaxKeepAlive(res.maxKeepAlive || 0);
      setLifecycleSaved(true);
      setTimeout(() => setLifecycleSaved(false), 1800);
    } catch (err: unknown) {
      setLifecycleError(err instanceof Error ? err.message : String(err));
    } finally {
      setLifecycleSaving(false);
    }
  }

  async function onRestartServer() {
    if (!confirm("Restart the server? All browser connections will briefly disconnect. Sessions will reconnect automatically.")) return;

    setRestarting(true);
    setRestartError("");
    useStore.getState().setServerRestarting(true);

    try {
      await api.restartServer();
    } catch (e: unknown) {
      // Distinguish server-returned errors (e.g. busy sessions) from network
      // errors (expected when the server shuts down mid-request).
      const msg = e instanceof Error ? e.message : String(e);
      const isNetworkError = !msg || msg.includes("fetch") || msg.includes("Failed") || msg.includes("ECONNREFUSED");
      if (!isNetworkError) {
        setRestartError(msg);
        setRestarting(false);
        useStore.getState().setServerRestarting(false);
        return;
      }
    }

    // Poll for server to come back
    healthPollRef.current = setInterval(async () => {
      const healthy = await checkHealth();
      if (healthy) {
        if (healthPollRef.current) clearInterval(healthPollRef.current);
        if (healthTimeoutRef.current) clearTimeout(healthTimeoutRef.current);
        healthPollRef.current = null;
        healthTimeoutRef.current = null;
        // Reload to pick up new frontend assets (especially in prod mode)
        window.location.reload();
      }
    }, 2000);

    // Timeout after 120s
    healthTimeoutRef.current = setTimeout(() => {
      if (healthPollRef.current) clearInterval(healthPollRef.current);
      healthPollRef.current = null;
      healthTimeoutRef.current = null;
      useStore.getState().setServerRestarting(false);
      setRestarting(false);
      setRestartError("Server did not come back within 120 seconds. Check your terminal.");
    }, 120_000);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const link = document.createElement("a");
      link.href = api.exportSessionsUrl();
      link.download = "";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setTimeout(() => setExporting(false), 2000);
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    setImportPhase("uploading");
    setImportPct(0);
    try {
      const stats = await api.importSessions(file, (phase, pct) => {
        setImportPhase(phase);
        setImportPct(pct);
      });
      setImportResult(stats);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Settings</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Configure notifications, appearance, and workspace defaults.
            </p>
          </div>
          {!embedded && (
            <button
              onClick={() => {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              }}
              className="px-3 py-1.5 rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Back
            </button>
          )}
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}

        <div className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-cc-fg">Notifications</h2>
          <button
            type="button"
            onClick={toggleNotificationSound}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          >
            <span>Sound</span>
            <span className="text-xs text-cc-muted">{notificationSound ? "On" : "Off"}</span>
          </button>
          {notificationApiAvailable && (
            <button
              type="button"
              onClick={async () => {
                if (!notificationDesktop) {
                  if (Notification.permission !== "granted") {
                    const result = await Notification.requestPermission();
                    if (result !== "granted") return;
                  }
                  setNotificationDesktop(true);
                } else {
                  setNotificationDesktop(false);
                }
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
            >
              <span>Desktop Alerts</span>
              <span className="text-xs text-cc-muted">{notificationDesktop ? "On" : "Off"}</span>
            </button>
          )}
        </div>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-cc-fg">Display</h2>
          <button
            type="button"
            onClick={toggleShowUsageBars}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          >
            <span>Usage Bars in Sidebar</span>
            <span className="text-xs text-cc-muted">{showUsageBars ? "On" : "Off"}</span>
          </button>
        </div>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-cc-fg">Server</h2>
            <p className="mt-1 text-xs text-cc-muted">
              Restart the server process. Useful after pulling new code.
              Sessions will reconnect automatically.
            </p>
          </div>

          {!restartSupported && (
            <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
              Restart not available. Start the server with <code className="font-mono bg-cc-hover px-1 py-0.5 rounded">make dev</code> or <code className="font-mono bg-cc-hover px-1 py-0.5 rounded">make serve</code> to enable.
            </div>
          )}

          {restartError && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {restartError}
            </div>
          )}

          <button
            type="button"
            onClick={onRestartServer}
            disabled={restarting || !restartSupported}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              restarting || !restartSupported
                ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
            }`}
          >
            {restarting ? "Restarting..." : "Restart Server"}
          </button>
        </div>

        <form
          onSubmit={onSaveBinaries}
          className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4"
        >
          <div>
            <h2 className="text-sm font-semibold text-cc-fg">CLI Binaries</h2>
            <p className="mt-1 text-xs text-cc-muted">
              Custom path or command for backend CLIs. Leave empty to auto-detect from PATH.
              New sessions use this immediately; existing sessions pick it up on relaunch.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="claude-binary">
              Claude Code
            </label>
            <div className="flex gap-2">
              <input
                id="claude-binary"
                type="text"
                value={claudeBin}
                onChange={(e) => setClaudeBin(e.target.value)}
                placeholder="claude (auto-detect)"
                className="flex-1 px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60 font-mono"
              />
              <button
                type="button"
                onClick={() => onTestBinary("claude")}
                disabled={claudeTesting}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  claudeTesting
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-hover text-cc-fg hover:bg-cc-active cursor-pointer"
                }`}
              >
                {claudeTesting ? "Testing..." : "Test"}
              </button>
            </div>
            {claudeTest && (
              <p className={`mt-1.5 text-xs ${claudeTest.ok ? "text-cc-success" : "text-cc-error"}`}>
                {claudeTest.ok
                  ? `${claudeTest.resolvedPath} — ${claudeTest.version}`
                  : claudeTest.error}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="codex-binary">
              Codex
            </label>
            <div className="flex gap-2">
              <input
                id="codex-binary"
                type="text"
                value={codexBin}
                onChange={(e) => setCodexBin(e.target.value)}
                placeholder="codex (auto-detect)"
                className="flex-1 px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60 font-mono"
              />
              <button
                type="button"
                onClick={() => onTestBinary("codex")}
                disabled={codexTesting}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  codexTesting
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-hover text-cc-fg hover:bg-cc-active cursor-pointer"
                }`}
              >
                {codexTesting ? "Testing..." : "Test"}
              </button>
            </div>
            {codexTest && (
              <p className={`mt-1.5 text-xs ${codexTest.ok ? "text-cc-success" : "text-cc-error"}`}>
                {codexTest.ok
                  ? `${codexTest.resolvedPath} — ${codexTest.version}`
                  : codexTest.error}
              </p>
            )}
          </div>

          {binError && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {binError}
            </div>
          )}

          {binSaved && (
            <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
              Binary settings saved.
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={binSaving || loading}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                binSaving || loading
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              }`}
            >
              {binSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>

        <form
          onSubmit={onSaveLifecycle}
          className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4"
        >
          <div>
            <h2 className="text-sm font-semibold text-cc-fg">Session Lifecycle</h2>
            <p className="mt-1 text-xs text-cc-muted">
              Limit how many CLI processes stay alive. Oldest idle sessions are
              killed first when the limit is exceeded. Busy sessions are never killed.
              Killed sessions can be relaunched from the sidebar context menu.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="max-keep-alive">
              Max Keep-Alive
            </label>
            <input
              id="max-keep-alive"
              type="number"
              min={0}
              step={1}
              value={maxKeepAlive}
              onChange={(e) => setMaxKeepAlive(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              className="w-24 px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
            />
            <p className="mt-1.5 text-xs text-cc-muted">
              Maximum number of live CLI processes. Set to 0 for unlimited.
            </p>
          </div>

          {lifecycleError && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {lifecycleError}
            </div>
          )}

          {lifecycleSaved && (
            <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
              Session lifecycle settings saved.
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={lifecycleSaving || loading}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                lifecycleSaving || loading
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              }`}
            >
              {lifecycleSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>

        <form
          onSubmit={onSavePushover}
          className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4"
        >
          <div>
            <h2 className="text-sm font-semibold text-cc-fg">Push Notifications (Pushover)</h2>
            <p className="mt-1 text-xs text-cc-muted">
              Get push notifications on your phone when sessions need attention.
              Get credentials at pushover.net.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="po-user-key">
              User Key
            </label>
            <input
              id="po-user-key"
              type="password"
              value={poUserKey}
              onChange={(e) => setPoUserKey(e.target.value)}
              placeholder={poConfigured ? "Configured. Enter a new key to replace." : "Your Pushover user key"}
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="po-api-token">
              API Token
            </label>
            <input
              id="po-api-token"
              type="password"
              value={poApiToken}
              onChange={(e) => setPoApiToken(e.target.value)}
              placeholder={poConfigured ? "Configured. Enter a new token to replace." : "Your Pushover API/app token"}
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="po-base-url">
              Base URL
            </label>
            <input
              id="po-base-url"
              type="text"
              value={poBaseUrl}
              onChange={(e) => setPoBaseUrl(e.target.value)}
              placeholder="http://localhost:3456"
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
            <p className="mt-1.5 text-xs text-cc-muted">
              The URL your phone uses to reach this server. Used for deep links in notifications.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="po-delay">
              Delay (seconds)
            </label>
            <input
              id="po-delay"
              type="number"
              min={5}
              max={300}
              value={poDelay}
              onChange={(e) => setPoDelay(Number(e.target.value) || 30)}
              className="w-24 px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
            />
            <p className="mt-1.5 text-xs text-cc-muted">
              Wait this long before sending a push notification (5-300s).
            </p>
          </div>

          <button
            type="button"
            onClick={() => setPoEnabled(!poEnabled)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          >
            <span>Enabled</span>
            <span className="text-xs text-cc-muted">{poEnabled ? "On" : "Off"}</span>
          </button>

          {poError && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {poError}
            </div>
          )}

          {poSaved && (
            <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
              Pushover settings saved.
            </div>
          )}

          {poTestResult && (
            <div className={`px-3 py-2 rounded-lg text-xs ${
              poTestResult.ok
                ? "bg-cc-success/10 border border-cc-success/20 text-cc-success"
                : "bg-cc-error/10 border border-cc-error/20 text-cc-error"
            }`}>
              {poTestResult.ok ? "Test notification sent!" : `Test failed: ${poTestResult.error}`}
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs text-cc-muted">
                {loading ? "Loading..." : poConfigured ? "Pushover configured" : "Not configured"}
              </span>
              {poConfigured && (
                <button
                  type="button"
                  onClick={onTestPushover}
                  disabled={poTesting || !poConfigured}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    poTesting || !poConfigured
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                      : "bg-cc-hover text-cc-fg hover:bg-cc-active cursor-pointer"
                  }`}
                >
                  {poTesting ? "Sending..." : "Send Test"}
                </button>
              )}
            </div>
            <button
              type="submit"
              disabled={poSaving || loading}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                poSaving || loading
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              }`}
            >
              {poSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-cc-fg">Appearance</h2>
          <button
            type="button"
            onClick={toggleDarkMode}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          >
            <span>Theme</span>
            <span className="text-xs text-cc-muted">{darkMode ? "Dark" : "Light"}</span>
          </button>
          <div className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg">
            <span>Zoom</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setZoomLevel(zoomLevel - 0.1)}
                disabled={zoomLevel <= 0.2}
                className="w-6 h-6 flex items-center justify-center rounded text-xs font-medium hover:bg-cc-active transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              >
                −
              </button>
              <input
                type="text"
                value={Math.round(zoomLevel * 100) + "%"}
                onChange={(e) => {
                  const num = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10);
                  if (!isNaN(num)) setZoomLevel(num / 100);
                }}
                className="w-12 text-center text-xs text-cc-muted bg-transparent border border-cc-border rounded px-1 py-0.5 focus:outline-none focus:border-cc-primary/60"
              />
              <button
                type="button"
                onClick={() => setZoomLevel(zoomLevel + 0.1)}
                disabled={zoomLevel >= 4.0}
                className="w-6 h-6 flex items-center justify-center rounded text-xs font-medium hover:bg-cc-active transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              >
                +
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-cc-fg">Environments</h2>
          <p className="text-xs text-cc-muted">
            Manage reusable environment profiles used when creating sessions.
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.hash = "#/environments";
            }}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
          >
            Open Environments Page
          </button>
        </div>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-cc-fg">Session Data</h2>
            <p className="mt-1 text-xs text-cc-muted">
              Export all sessions to a portable archive, or import sessions from another machine.
              Paths are automatically rewritten to match this machine. Existing sessions are only
              overwritten if the archive version is newer.
            </p>
          </div>

          <input
            ref={importInputRef}
            type="file"
            accept=".tar.zst,.zst"
            onChange={handleImportFile}
            className="hidden"
          />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                exporting
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-cc-hover text-cc-fg hover:bg-cc-active cursor-pointer"
              }`}
            >
              {exporting ? "Exporting..." : "Export All Sessions"}
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                importing
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-cc-hover text-cc-fg hover:bg-cc-active cursor-pointer"
              }`}
            >
              {importing ? "Importing..." : "Import Sessions"}
            </button>
          </div>

          {importing && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-cc-muted">
                <span>{importPhase === "uploading" ? "Uploading archive..." : "Processing import..."}</span>
                <span>{importPhase === "uploading" ? `${importPct}%` : ""}</span>
              </div>
              <div className="h-1.5 rounded-full bg-cc-hover overflow-hidden">
                {importPhase === "uploading" ? (
                  <div
                    className="h-full bg-cc-accent rounded-full transition-[width] duration-200"
                    style={{ width: `${importPct}%` }}
                  />
                ) : (
                  <div className="h-full bg-cc-accent rounded-full animate-pulse w-full" />
                )}
              </div>
            </div>
          )}

          {importError && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              Import failed: {importError}
            </div>
          )}

          {importResult && (
            <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success space-y-0.5">
              <div className="font-medium">Import complete</div>
              {importResult.sessionsNew > 0 && <div>{importResult.sessionsNew} new sessions imported</div>}
              {importResult.sessionsUpdated > 0 && <div>{importResult.sessionsUpdated} updated (archive was newer)</div>}
              {importResult.sessionsSkipped > 0 && <div>{importResult.sessionsSkipped} skipped (local was newer)</div>}
              {importResult.worktreeSessionsNeedingRecreation > 0 && (
                <div>{importResult.worktreeSessionsNeedingRecreation} worktree sessions will recreate on open</div>
              )}
              {importResult.pathsRewritten && <div>Paths rewritten for this machine</div>}
            </div>
          )}
        </div>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5">
          <NamerDebugPanel />
        </div>
      </div>
    </div>
  );
}
