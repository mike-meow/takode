import { useEffect, useRef, useState } from "react";
import { api, checkHealth, type ImportStats, type AutoApprovalConfig } from "../api.js";
import { useStore } from "../store.js";
import { NamerDebugPanel } from "./NamerDebugPanel.js";
import { AutoApprovalDebugPanel } from "./AutoApprovalDebugPanel.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { FolderPicker } from "./FolderPicker.js";

import { navigateToSession, navigateToMostRecentSession } from "../utils/routing.js";

const SCROLL_STORAGE_KEY = "cc-settings-scroll";

interface SettingsPageProps {
  embedded?: boolean;
  isActive?: boolean;
}

export function SettingsPage({ embedded = false, isActive = true }: SettingsPageProps) {
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

  // Auto-approval state
  const [aaEnabled, setAaEnabled] = useState(false);
  const [aaModel, setAaModel] = useState("");
  const [aaSaving, setAaSaving] = useState(false);
  const [aaError, setAaError] = useState("");
  const [aaConfigs, setAaConfigs] = useState<AutoApprovalConfig[]>([]);
  const [aaConfigsLoading, setAaConfigsLoading] = useState(false);
  const [aaNewProjectPaths, setAaNewProjectPaths] = useState<string[]>([]);
  const [aaNewPathInput, setAaNewPathInput] = useState("");
  const [aaNewLabel, setAaNewLabel] = useState("");
  const [aaNewCriteria, setAaNewCriteria] = useState("");
  const [aaCreating, setAaCreating] = useState(false);
  const [aaCreateError, setAaCreateError] = useState("");
  const [showAaFolderPicker, setShowAaFolderPicker] = useState(false);

  // Session auto-namer state
  const [namerBackend, setNamerBackend] = useState("");
  const [namerApiKey, setNamerApiKey] = useState("");
  const [namerBaseUrl, setNamerBaseUrl] = useState("");
  const [namerModel, setNamerModel] = useState("");
  const [namerSaving, setNamerSaving] = useState(false);
  const [namerSaved, setNamerSaved] = useState(false);
  const [namerError, setNamerError] = useState("");

  // Session export/import state
  const importInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStep, setImportStep] = useState("");
  const [importPct, setImportPct] = useState<number | undefined>(undefined);
  const [importResult, setImportResult] = useState<ImportStats | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  function loadAutoApprovalConfigs() {
    setAaConfigsLoading(true);
    api.getAutoApprovalConfigs()
      .then(setAaConfigs)
      .catch(() => {})
      .finally(() => setAaConfigsLoading(false));
  }

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
        setAaEnabled(s.autoApprovalEnabled);
        setAaModel(s.autoApprovalModel ?? "");
        setNamerBackend(s.namerBackend || "");
        setNamerApiKey(s.namerOpenaiApiKey === "***" ? "***" : (s.namerOpenaiApiKey || ""));
        setNamerBaseUrl(s.namerOpenaiBaseUrl || "");
        setNamerModel(s.namerOpenaiModel || "");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    loadAutoApprovalConfigs();
  }, []);

  // Restore scroll position on mount, save on scroll (debounced) and unmount
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    try {
      const saved = localStorage.getItem(SCROLL_STORAGE_KEY);
      if (saved) el.scrollTop = JSON.parse(saved);
    } catch { /* ignore corrupt data */ }

    let timeout: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        localStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(el.scrollTop));
      }, 300);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      clearTimeout(timeout);
      localStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(el.scrollTop));
    };
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
    setImportStep("");
    setImportPct(undefined);
    try {
      const stats = await api.importSessions(file, (_step, message, pct) => {
        setImportStep(message);
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
    <div ref={scrollRef} className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 space-y-4">
        <div className="flex items-start justify-between gap-3 mb-2">
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
          <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}

        {/* ── 1. Appearance & Display ──────────────────────────── */}
        <CollapsibleSection id="appearance" title="Appearance & Display">
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
          <button
            type="button"
            onClick={toggleShowUsageBars}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          >
            <span>Usage Bars in Sidebar</span>
            <span className="text-xs text-cc-muted">{showUsageBars ? "On" : "Off"}</span>
          </button>
        </CollapsibleSection>

        {/* ── 2. Notifications ─────────────────────────────────── */}
        <CollapsibleSection id="notifications" title="Notifications">
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
        </CollapsibleSection>

        {/* ── 3. CLI & Backends ────────────────────────────────── */}
        <CollapsibleSection
          id="cli"
          title="CLI & Backends"
          description="Custom path or command for backend CLIs. Leave empty to auto-detect from PATH. New sessions use this immediately; existing sessions pick it up on relaunch."
          as="form"
          onSubmit={onSaveBinaries}
        >
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

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                window.location.hash = "#/environments";
              }}
              className="px-3 py-2 rounded-lg text-sm font-medium bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
            >
              Manage Environments
            </button>
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
        </CollapsibleSection>

        {/* ── 4. Sessions ──────────────────────────────────────── */}
        <CollapsibleSection id="sessions" title="Sessions">
          {/* Session Lifecycle (inner form — Sessions group contains two sub-sections) */}
          <form onSubmit={onSaveLifecycle} className="space-y-3">
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
                Oldest idle sessions are killed first. Busy sessions are never killed.
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

          {/* Session Auto-Namer backend */}
          <div className="border-t border-cc-border pt-3 space-y-3">
            <div>
              <span className="text-sm font-medium text-cc-fg">Auto-Namer Backend</span>
              <p className="mt-1 text-xs text-cc-muted">
                Choose how sessions are automatically named. Defaults to Claude CLI (<code className="font-mono bg-cc-hover px-1 py-0.5 rounded">claude -p</code>).
                Use OpenAI-compatible API on machines without Claude CLI.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-cc-muted mb-1.5">Backend</label>
              <select
                value={namerBackend || "claude"}
                onChange={(e) => setNamerBackend(e.target.value === "claude" ? "" : e.target.value)}
                className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
              >
                <option value="claude">Claude CLI (default)</option>
                <option value="openai">OpenAI-compatible API</option>
              </select>
            </div>

            {(namerBackend === "openai") && (
              <div className="space-y-3 pl-3 border-l-2 border-cc-border">
                <div>
                  <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="namer-api-key">
                    API Key
                  </label>
                  <input
                    id="namer-api-key"
                    type="password"
                    value={namerApiKey}
                    onChange={(e) => setNamerApiKey(e.target.value)}
                    onFocus={() => { if (namerApiKey === "***") setNamerApiKey(""); }}
                    placeholder="sk-..."
                    className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="namer-base-url">
                    Base URL
                  </label>
                  <input
                    id="namer-base-url"
                    type="text"
                    value={namerBaseUrl}
                    onChange={(e) => setNamerBaseUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 font-mono"
                  />
                  <p className="mt-1 text-xs text-cc-muted">
                    Leave empty for OpenAI. Use a custom URL for LiteLLM, Ollama, etc.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="namer-model">
                    Model
                  </label>
                  <input
                    id="namer-model"
                    type="text"
                    value={namerModel}
                    onChange={(e) => setNamerModel(e.target.value)}
                    placeholder="gpt-4o-mini"
                    className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 font-mono"
                  />
                </div>
              </div>
            )}

            {namerError && (
              <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                {namerError}
              </div>
            )}
            {namerSaved && (
              <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
                Auto-namer settings saved.
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                disabled={namerSaving || loading}
                onClick={async () => {
                  setNamerSaving(true);
                  setNamerError("");
                  setNamerSaved(false);
                  try {
                    const update: Record<string, string> = {
                      namerBackend: namerBackend || "",
                    };
                    if (namerBackend === "openai") {
                      if (namerApiKey !== "***") update.namerOpenaiApiKey = namerApiKey;
                      update.namerOpenaiBaseUrl = namerBaseUrl;
                      update.namerOpenaiModel = namerModel;
                    }
                    await api.updateSettings(update);
                    setNamerSaved(true);
                    setTimeout(() => setNamerSaved(false), 3000);
                  } catch (err: unknown) {
                    setNamerError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setNamerSaving(false);
                  }
                }}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  namerSaving || loading
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                }`}
              >
                {namerSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          {/* Session Data — export/import */}
          <div className="border-t border-cc-border pt-3 space-y-3">
            <div>
              <span className="text-sm font-medium text-cc-fg">Session Data</span>
              <p className="mt-1 text-xs text-cc-muted">
                Export all sessions to a portable archive, or import sessions from another machine.
                Paths are automatically rewritten to match this machine.
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
                  <span>{importStep || "Starting import..."}</span>
                  <span>{importPct != null ? `${importPct}%` : ""}</span>
                </div>
                <div className="h-1.5 rounded-full bg-cc-hover overflow-hidden">
                  {importPct != null ? (
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
                {importResult.claudeSessionsRestored > 0 && (
                  <div>{importResult.claudeSessionsRestored} Claude Code sessions restored (conversation context preserved)</div>
                )}
                {importResult.worktreeSessionsNeedingRecreation > 0 && (
                  <div>{importResult.worktreeSessionsNeedingRecreation} worktree sessions will recreate on open</div>
                )}
                {importResult.pathsRewritten && <div>Paths rewritten for this machine</div>}
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* ── 5. Push Notifications (Pushover) ─────────────────── */}
        <CollapsibleSection
          id="pushover"
          title="Push Notifications (Pushover)"
          description="Get push notifications on your phone when sessions need attention. Get credentials at pushover.net."
          as="form"
          onSubmit={onSavePushover}
        >
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
        </CollapsibleSection>

        {/* ── 6. Auto-Approval (LLM) ──────────────────────────── */}
        <CollapsibleSection
          id="auto-approval"
          title="Auto-Approval (LLM)"
          description="When enabled, permission requests are first evaluated by a fast LLM against your project-specific criteria. If the LLM approves, the permission is auto-approved. Otherwise, it falls through to you as usual."
        >
          {/* Master toggle + model selector — auto-save on change */}
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-xs text-cc-fg cursor-pointer">
              <input
                type="checkbox"
                checked={aaEnabled}
                disabled={aaSaving}
                onChange={async (e) => {
                  const newEnabled = e.target.checked;
                  setAaEnabled(newEnabled);
                  setAaSaving(true);
                  setAaError("");
                  try {
                    const res = await api.updateSettings({ autoApprovalEnabled: newEnabled });
                    setAaEnabled(res.autoApprovalEnabled);
                  } catch (err: unknown) {
                    setAaEnabled(!newEnabled);
                    setAaError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setAaSaving(false);
                  }
                }}
                className="accent-cc-primary"
              />
              Enabled {aaSaving && <span className="text-cc-muted">(saving...)</span>}
            </label>
            <label className="flex items-center gap-2 text-xs text-cc-fg">
              <span className="text-cc-muted">Model:</span>
              <select
                value={aaModel}
                disabled={aaSaving}
                onChange={async (e) => {
                  const newModel = e.target.value;
                  const oldModel = aaModel;
                  setAaModel(newModel);
                  setAaSaving(true);
                  setAaError("");
                  try {
                    const res = await api.updateSettings({ autoApprovalModel: newModel });
                    setAaModel(res.autoApprovalModel);
                  } catch (err: unknown) {
                    setAaModel(oldModel);
                    setAaError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setAaSaving(false);
                  }
                }}
                className="px-2 py-1 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/50"
              >
                <option value="">Default (session model)</option>
                <option value="haiku">Haiku (fast, cheap)</option>
                <option value="sonnet">Sonnet (more capable)</option>
              </select>
            </label>
            {aaError && <span className="text-xs text-cc-error">{aaError}</span>}
          </div>

          {/* Project configs list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-cc-fg">Project Rules</span>
              <button
                type="button"
                onClick={loadAutoApprovalConfigs}
                disabled={aaConfigsLoading}
                className="text-[10px] text-cc-muted hover:text-cc-fg cursor-pointer"
              >
                {aaConfigsLoading ? "Loading..." : "Refresh"}
              </button>
            </div>

            {aaConfigs.length === 0 && !aaConfigsLoading && (
              <p className="text-xs text-cc-muted italic">No project rules configured yet.</p>
            )}

            {aaConfigs.map((config) => (
              <AutoApprovalConfigCard
                key={config.slug}
                config={config}
                onUpdate={loadAutoApprovalConfigs}
              />
            ))}

            {/* Add new config form */}
            <div className="border border-dashed border-cc-border rounded-lg p-3 space-y-2">
              <span className="text-xs font-medium text-cc-muted">Add Project Rule</span>

              {/* Project paths */}
              <div className="space-y-1">
                {aaNewProjectPaths.map((p, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="flex-1 px-2 py-1 text-[10px] font-mono-code bg-cc-hover rounded truncate" title={p}>
                      {p}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAaNewProjectPaths(aaNewProjectPaths.filter((_, j) => j !== i))}
                      className="text-[10px] text-cc-error/60 hover:text-cc-error cursor-pointer px-1"
                      title="Remove path"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={aaNewPathInput}
                    onChange={(e) => setAaNewPathInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const trimmed = aaNewPathInput.trim();
                        if (trimmed && !aaNewProjectPaths.includes(trimmed)) {
                          setAaNewProjectPaths([...aaNewProjectPaths, trimmed]);
                          if (!aaNewLabel.trim()) setAaNewLabel(trimmed.split("/").pop() || "");
                          setAaNewPathInput("");
                        }
                      }
                    }}
                    placeholder={aaNewProjectPaths.length === 0
                      ? "Project path (e.g. /home/user/my-project)"
                      : "Add another project path..."}
                    className="flex-1 px-2.5 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAaFolderPicker(true)}
                    className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                    title="Browse folders"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                    </svg>
                  </button>
                  {aaNewPathInput.trim() && (
                    <button
                      type="button"
                      onClick={() => {
                        const trimmed = aaNewPathInput.trim();
                        if (trimmed && !aaNewProjectPaths.includes(trimmed)) {
                          setAaNewProjectPaths([...aaNewProjectPaths, trimmed]);
                          if (!aaNewLabel.trim()) setAaNewLabel(trimmed.split("/").pop() || "");
                          setAaNewPathInput("");
                        }
                      }}
                      className="text-[10px] text-cc-primary hover:text-cc-primary-hover cursor-pointer px-1"
                    >
                      Add
                    </button>
                  )}
                </div>
              </div>
              {showAaFolderPicker && (
                <FolderPicker
                  initialPath={aaNewPathInput || ""}
                  onSelect={(path) => {
                    if (!aaNewProjectPaths.includes(path)) {
                      setAaNewProjectPaths([...aaNewProjectPaths, path]);
                    }
                    if (!aaNewLabel.trim()) setAaNewLabel(path.split("/").pop() || "");
                    setAaNewPathInput("");
                  }}
                  onClose={() => setShowAaFolderPicker(false)}
                />
              )}
              <input
                type="text"
                value={aaNewLabel}
                onChange={(e) => setAaNewLabel(e.target.value)}
                placeholder="Label (e.g. My Project)"
                className="w-full px-2.5 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50"
              />
              <textarea
                value={aaNewCriteria}
                onChange={(e) => setAaNewCriteria(e.target.value)}
                placeholder="Criteria (natural language rules, e.g. 'Allow all read operations. Allow git commands. Deny rm and chmod.')"
                rows={3}
                className="w-full px-2.5 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50 resize-y"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={aaCreating || aaNewProjectPaths.length === 0 || !aaNewLabel.trim() || !aaNewCriteria.trim()}
                  onClick={async () => {
                    setAaCreating(true);
                    setAaCreateError("");
                    try {
                      await api.createAutoApprovalConfig({
                        projectPath: aaNewProjectPaths[0],
                        projectPaths: aaNewProjectPaths.length > 1 ? aaNewProjectPaths : undefined,
                        label: aaNewLabel.trim(),
                        criteria: aaNewCriteria.trim(),
                      });
                      setAaNewProjectPaths([]);
                      setAaNewPathInput("");
                      setAaNewLabel("");
                      setAaNewCriteria("");
                      loadAutoApprovalConfigs();
                    } catch (err: unknown) {
                      setAaCreateError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setAaCreating(false);
                    }
                  }}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {aaCreating ? "Creating..." : "Add Rule"}
                </button>
                {aaCreateError && <span className="text-xs text-cc-error">{aaCreateError}</span>}
              </div>
            </div>
          </div>

          {/* Debug panel */}
          <div className="border-t border-cc-border pt-4">
            <AutoApprovalDebugPanel />
          </div>
        </CollapsibleSection>

        {/* ── 7. Server & Diagnostics ──────────────────────────── */}
        <CollapsibleSection id="server" title="Server & Diagnostics">
          <div className="space-y-3">
            <p className="text-xs text-cc-muted">
              Restart the server process. Useful after pulling new code.
              Sessions will reconnect automatically.
            </p>

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

          <div className="border-t border-cc-border pt-4">
            <NamerDebugPanel />
          </div>
        </CollapsibleSection>
      </div>
    </div>
  );
}

// ── AutoApprovalConfigCard — inline editable card for a single project config ──

function AutoApprovalConfigCard({
  config,
  onUpdate,
}: {
  config: AutoApprovalConfig;
  onUpdate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [criteria, setCriteria] = useState(config.criteria);
  const [label, setLabel] = useState(config.label);
  const [paths, setPaths] = useState<string[]>(config.projectPaths?.length ? config.projectPaths : [config.projectPath]);
  const [enabled, setEnabled] = useState(config.enabled);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [newPath, setNewPath] = useState("");
  const [showPathPicker, setShowPathPicker] = useState(false);

  async function handleSave() {
    const validPaths = paths.filter((p) => p.trim());
    if (validPaths.length === 0) {
      setError("At least one project path is required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.updateAutoApprovalConfig(config.slug, { label, criteria, projectPaths: validPaths });
      setEditing(false);
      onUpdate();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await api.deleteAutoApprovalConfig(config.slug);
      onUpdate();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  function addPath() {
    const trimmed = newPath.trim();
    if (trimmed && !paths.includes(trimmed)) {
      setPaths([...paths, trimmed]);
      setNewPath("");
    }
  }

  function removePath(idx: number) {
    if (paths.length <= 1) return;
    setPaths(paths.filter((_, i) => i !== idx));
  }

  const allPaths = config.projectPaths?.length ? config.projectPaths : [config.projectPath];

  return (
    <div className="border border-cc-border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={async (e) => {
              const newEnabled = e.target.checked;
              setEnabled(newEnabled);
              setSaving(true);
              setError("");
              try {
                await api.updateAutoApprovalConfig(config.slug, { enabled: newEnabled });
                onUpdate();
              } catch (err: unknown) {
                setEnabled(!newEnabled);
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setSaving(false);
              }
            }}
            className="accent-cc-primary"
          />
          <span className="text-xs font-medium text-cc-fg">{config.label}</span>
        </label>
        <span className="text-[10px] text-cc-muted font-mono-code truncate flex-1" title={allPaths.join(", ")}>
          {allPaths.length === 1 ? allPaths[0] : `${allPaths.length} projects`}
        </span>
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          className="text-[10px] text-cc-muted hover:text-cc-fg cursor-pointer"
        >
          {editing ? "Cancel" : "Edit"}
        </button>
        {confirmDelete ? (
          <>
            <span className="text-[10px] text-cc-error">Sure?</span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="text-[10px] text-cc-error font-medium hover:underline cursor-pointer disabled:opacity-50"
            >
              {deleting ? "..." : "Yes"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="text-[10px] text-cc-muted hover:text-cc-fg cursor-pointer"
            >
              No
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={handleDelete}
            className="text-[10px] text-cc-error/70 hover:text-cc-error cursor-pointer"
          >
            Delete
          </button>
        )}
      </div>

      {/* Show all paths when not editing (collapsed view) */}
      {!editing && allPaths.length > 1 && (
        <div className="space-y-0.5">
          {allPaths.map((p, i) => (
            <div key={i} className="text-[10px] text-cc-muted font-mono-code truncate" title={p}>
              {p}
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <div className="space-y-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label"
            className="w-full px-2.5 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50"
          />

          {/* Project paths list */}
          <div className="space-y-1">
            <span className="text-[10px] text-cc-muted">Project Paths</span>
            {paths.map((p, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="flex-1 px-2 py-1 text-[10px] font-mono-code bg-cc-hover rounded truncate" title={p}>
                  {p}
                </span>
                <button
                  type="button"
                  onClick={() => removePath(i)}
                  disabled={paths.length <= 1}
                  className="text-[10px] text-cc-error/60 hover:text-cc-error cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed px-1"
                  title="Remove path"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPath(); } }}
                placeholder="Add another project path..."
                className="flex-1 px-2 py-1 text-[10px] bg-cc-input-bg border border-cc-border rounded text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50"
              />
              <button
                type="button"
                onClick={() => setShowPathPicker(true)}
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                title="Browse folders"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                  <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={addPath}
                disabled={!newPath.trim()}
                className="text-[10px] text-cc-primary hover:text-cc-primary-hover cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed px-1"
              >
                Add
              </button>
            </div>
            {showPathPicker && (
              <FolderPicker
                initialPath={newPath || ""}
                onSelect={(path) => {
                  if (!paths.includes(path)) {
                    setPaths([...paths, path]);
                  }
                  setNewPath("");
                }}
                onClose={() => setShowPathPicker(false)}
              />
            )}
          </div>

          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={3}
            className="w-full px-2.5 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50 resize-y"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white disabled:opacity-50 transition-colors cursor-pointer"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {error && <span className="text-xs text-cc-error">{error}</span>}
          </div>
        </div>
      ) : (
        <p className="text-xs text-cc-muted whitespace-pre-wrap">{config.criteria}</p>
      )}
    </div>
  );
}
