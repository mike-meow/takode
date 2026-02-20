import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { NamerDebugPanel } from "./NamerDebugPanel.js";

import { navigateToSession, navigateToMostRecentSession } from "../utils/routing.js";

interface SettingsPageProps {
  embedded?: boolean;
}

export function SettingsPage({ embedded = false }: SettingsPageProps) {
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("openrouter/free");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const zoomLevel = useStore((s) => s.zoomLevel);
  const setZoomLevel = useStore((s) => s.setZoomLevel);
  const notificationSound = useStore((s) => s.notificationSound);
  const toggleNotificationSound = useStore((s) => s.toggleNotificationSound);
  const notificationDesktop = useStore((s) => s.notificationDesktop);
  const setNotificationDesktop = useStore((s) => s.setNotificationDesktop);
  const notificationApiAvailable = typeof Notification !== "undefined";

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

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setConfigured(s.openrouterApiKeyConfigured);
        setOpenrouterModel(s.openrouterModel || "openrouter/free");
        setPoConfigured(s.pushoverConfigured);
        setPoEnabled(s.pushoverEnabled);
        setPoDelay(s.pushoverDelaySeconds);
        setPoBaseUrl(s.pushoverBaseUrl || "");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const nextKey = openrouterApiKey.trim();
      const payload: { openrouterApiKey?: string; openrouterModel: string } = {
        openrouterModel: openrouterModel.trim() || "openrouter/free",
      };
      if (nextKey) {
        payload.openrouterApiKey = nextKey;
      }

      const res = await api.updateSettings(payload);
      setConfigured(res.openrouterApiKeyConfigured);
      setOpenrouterApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

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

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Settings</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Configure API access, notifications, appearance, and workspace defaults.
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

        <form
          onSubmit={onSave}
          className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4"
        >
          <h2 className="text-sm font-semibold text-cc-fg">OpenRouter</h2>
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="openrouter-key">
              OpenRouter API Key
            </label>
            <input
              id="openrouter-key"
              type="password"
              value={openrouterApiKey}
              onChange={(e) => setOpenrouterApiKey(e.target.value)}
              placeholder={configured ? "Configured. Enter a new key to replace." : "sk-or-v1-..."}
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
            <p className="mt-1.5 text-xs text-cc-muted">
              Auto-renaming is disabled until this key is configured.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="openrouter-model">
              OpenRouter Model
            </label>
            <input
              id="openrouter-model"
              type="text"
              value={openrouterModel}
              onChange={(e) => setOpenrouterModel(e.target.value)}
              placeholder="openrouter/free"
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {error}
            </div>
          )}

          {saved && (
            <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
              Settings saved.
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-cc-muted">
              {loading ? "Loading..." : configured ? "OpenRouter key configured" : "OpenRouter key not configured"}
            </span>
            <button
              type="submit"
              disabled={saving || loading}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                saving || loading
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              }`}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
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

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5">
          <NamerDebugPanel />
        </div>
      </div>
    </div>
  );
}
