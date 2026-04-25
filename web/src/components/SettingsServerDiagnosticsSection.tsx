import { CollapsibleSection } from "./CollapsibleSection.js";
import type { SettingsSearchResults, SettingsSectionId } from "./settings-search.js";

export function SettingsServerDiagnosticsSection({
  logFile,
  restartSupported,
  restartError,
  restarting,
  onRestartServer,
  sectionSearch,
}: {
  logFile: string;
  restartSupported: boolean;
  restartError: string;
  restarting: boolean;
  onRestartServer: () => void;
  sectionSearch?: {
    results: SettingsSearchResults;
    id: SettingsSectionId;
  };
}) {
  return (
    <CollapsibleSection
      id="server"
      title="Server & Diagnostics"
      hidden={sectionSearch ? !sectionSearch.results.visibleSectionIds.has(sectionSearch.id) : false}
      searchQuery={sectionSearch?.results.query}
      matchCount={sectionSearch ? (sectionSearch.results.sectionMatchCounts.get(sectionSearch.id) ?? 0) : 0}
    >
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium text-cc-fg">Log Viewer</p>
          <p className="mt-0.5 text-xs text-cc-muted">
            Structured server/runtime logs with live streaming, filtering, and Takode CLI access.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            window.location.hash = "#/logs";
          }}
          className="px-3 py-2 rounded-lg text-sm font-medium bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
        >
          Open Log Viewer
        </button>

        {logFile && (
          <div className="px-3 py-2 rounded-lg bg-cc-hover/60 border border-cc-border text-xs text-cc-muted font-mono break-all">
            {logFile}
          </div>
        )}

        <p className="text-xs text-cc-muted">
          CLI access: <code className="font-mono">takode logs --level warn,error --follow</code>
        </p>

        <div className="border-t border-cc-border pt-3 space-y-3">
          <p className="text-xs text-cc-muted">
            Restart the server process. Useful after pulling new code. Sessions will reconnect automatically.
          </p>

          {!restartSupported && (
            <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
              Restart not available. Start the server with{" "}
              <code className="font-mono bg-cc-hover px-1 py-0.5 rounded">make dev</code> or{" "}
              <code className="font-mono bg-cc-hover px-1 py-0.5 rounded">make serve</code> to enable.
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
      </div>
    </CollapsibleSection>
  );
}
