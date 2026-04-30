import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { api, type AutoApprovalConfig } from "../api.js";
import { AutoApprovalConfigCard } from "./AutoApprovalConfigCard.js";
import { AutoApprovalDebugPanel } from "./AutoApprovalDebugPanel.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { FolderPicker } from "./FolderPicker.js";

type SectionSearchProps = Pick<ComponentProps<typeof CollapsibleSection>, "hidden" | "searchQuery" | "matchCount">;

interface SettingsAutoApprovalSectionProps {
  sectionSearchProps: SectionSearchProps;
  aaEnabled: boolean;
  setAaEnabled: Dispatch<SetStateAction<boolean>>;
  aaModel: string;
  setAaModel: Dispatch<SetStateAction<string>>;
  aaMaxConcurrency: number;
  setAaMaxConcurrency: Dispatch<SetStateAction<number>>;
  aaTimeoutSeconds: number;
  setAaTimeoutSeconds: Dispatch<SetStateAction<number>>;
  aaSaving: boolean;
  setAaSaving: Dispatch<SetStateAction<boolean>>;
  aaError: string;
  setAaError: Dispatch<SetStateAction<string>>;
  aaConfigs: AutoApprovalConfig[];
  aaConfigsLoading: boolean;
  aaNewProjectPaths: string[];
  setAaNewProjectPaths: Dispatch<SetStateAction<string[]>>;
  aaNewPathInput: string;
  setAaNewPathInput: Dispatch<SetStateAction<string>>;
  aaNewLabel: string;
  setAaNewLabel: Dispatch<SetStateAction<string>>;
  aaNewCriteria: string;
  setAaNewCriteria: Dispatch<SetStateAction<string>>;
  aaCreating: boolean;
  setAaCreating: Dispatch<SetStateAction<boolean>>;
  aaCreateError: string;
  setAaCreateError: Dispatch<SetStateAction<string>>;
  showAaFolderPicker: boolean;
  setShowAaFolderPicker: Dispatch<SetStateAction<boolean>>;
  loadAutoApprovalConfigs: () => void;
}

export function SettingsAutoApprovalSection({
  sectionSearchProps,
  aaEnabled,
  setAaEnabled,
  aaModel,
  setAaModel,
  aaMaxConcurrency,
  setAaMaxConcurrency,
  aaTimeoutSeconds,
  setAaTimeoutSeconds,
  aaSaving,
  setAaSaving,
  aaError,
  setAaError,
  aaConfigs,
  aaConfigsLoading,
  aaNewProjectPaths,
  setAaNewProjectPaths,
  aaNewPathInput,
  setAaNewPathInput,
  aaNewLabel,
  setAaNewLabel,
  aaNewCriteria,
  setAaNewCriteria,
  aaCreating,
  setAaCreating,
  aaCreateError,
  setAaCreateError,
  showAaFolderPicker,
  setShowAaFolderPicker,
  loadAutoApprovalConfigs,
}: SettingsAutoApprovalSectionProps) {
  function addPendingProjectPath(path: string) {
    const trimmed = path.trim();
    if (!trimmed || aaNewProjectPaths.includes(trimmed)) return;
    setAaNewProjectPaths([...aaNewProjectPaths, trimmed]);
    if (!aaNewLabel.trim()) setAaNewLabel(trimmed.split("/").pop() || "");
    setAaNewPathInput("");
  }

  async function saveAutoApprovalEnabled(nextEnabled: boolean) {
    setAaEnabled(nextEnabled);
    setAaSaving(true);
    setAaError("");
    try {
      const response = await api.updateSettings({ autoApprovalEnabled: nextEnabled });
      setAaEnabled(response.autoApprovalEnabled);
    } catch (err: unknown) {
      setAaEnabled(!nextEnabled);
      setAaError(err instanceof Error ? err.message : String(err));
    } finally {
      setAaSaving(false);
    }
  }

  async function saveAutoApprovalModel(nextModel: string) {
    const previousModel = aaModel;
    setAaModel(nextModel);
    setAaSaving(true);
    setAaError("");
    try {
      const response = await api.updateSettings({ autoApprovalModel: nextModel });
      setAaModel(response.autoApprovalModel);
    } catch (err: unknown) {
      setAaModel(previousModel);
      setAaError(err instanceof Error ? err.message : String(err));
    } finally {
      setAaSaving(false);
    }
  }

  async function saveAutoApprovalMaxConcurrency(nextConcurrency: number) {
    const previousConcurrency = aaMaxConcurrency;
    setAaMaxConcurrency(nextConcurrency);
    setAaSaving(true);
    setAaError("");
    try {
      const response = await api.updateSettings({ autoApprovalMaxConcurrency: nextConcurrency });
      setAaMaxConcurrency(response.autoApprovalMaxConcurrency);
    } catch (err: unknown) {
      setAaMaxConcurrency(previousConcurrency);
      setAaError(err instanceof Error ? err.message : String(err));
    } finally {
      setAaSaving(false);
    }
  }

  async function saveAutoApprovalTimeout(nextTimeout: number) {
    const previousTimeout = aaTimeoutSeconds;
    setAaTimeoutSeconds(nextTimeout);
    setAaSaving(true);
    setAaError("");
    try {
      const response = await api.updateSettings({ autoApprovalTimeoutSeconds: nextTimeout });
      setAaTimeoutSeconds(response.autoApprovalTimeoutSeconds);
    } catch (err: unknown) {
      setAaTimeoutSeconds(previousTimeout);
      setAaError(err instanceof Error ? err.message : String(err));
    } finally {
      setAaSaving(false);
    }
  }

  return (
    <CollapsibleSection
      id="auto-approval"
      title="Auto-Approval (LLM)"
      description="When enabled, permission requests are first evaluated by a fast LLM against your project-specific criteria. If the LLM approves, the permission is auto-approved. Otherwise, it falls through to you as usual."
      {...sectionSearchProps}
    >
      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-cc-fg cursor-pointer">
          <input
            type="checkbox"
            checked={aaEnabled}
            disabled={aaSaving}
            onChange={(e) => {
              void saveAutoApprovalEnabled(e.target.checked);
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
            onChange={(e) => {
              void saveAutoApprovalModel(e.target.value);
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

      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-cc-fg">
          <span className="text-cc-muted">Max concurrency:</span>
          <input
            type="number"
            min={1}
            max={20}
            value={aaMaxConcurrency}
            disabled={aaSaving}
            onChange={(e) => {
              const nextConcurrency = Math.max(1, Math.min(20, Math.floor(Number(e.target.value) || 4)));
              void saveAutoApprovalMaxConcurrency(nextConcurrency);
            }}
            className="w-16 px-2 py-1 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/50"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-cc-fg">
          <span className="text-cc-muted">Timeout:</span>
          <input
            type="number"
            min={5}
            max={120}
            value={aaTimeoutSeconds}
            disabled={aaSaving}
            onChange={(e) => {
              const nextTimeout = Math.max(5, Math.min(120, Math.floor(Number(e.target.value) || 45)));
              void saveAutoApprovalTimeout(nextTimeout);
            }}
            className="w-16 px-2 py-1 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/50"
          />
          <span className="text-cc-muted">seconds</span>
        </label>
      </div>

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
          <AutoApprovalConfigCard key={config.slug} config={config} onUpdate={loadAutoApprovalConfigs} />
        ))}

        <div className="border border-dashed border-cc-border rounded-lg p-3 space-y-2">
          <span className="text-xs font-medium text-cc-muted">Add Project Rule</span>

          <div className="space-y-1">
            {aaNewProjectPaths.map((path, index) => (
              <div key={path} className="flex items-center gap-1">
                <span className="flex-1 px-2 py-1 text-[10px] font-mono-code bg-cc-hover rounded truncate" title={path}>
                  {path}
                </span>
                <button
                  type="button"
                  onClick={() => setAaNewProjectPaths(aaNewProjectPaths.filter((_, itemIndex) => itemIndex !== index))}
                  className="text-[10px] text-cc-error/60 hover:text-cc-error cursor-pointer px-1"
                  title="Remove path"
                >
                  x
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
                    addPendingProjectPath(aaNewPathInput);
                  }
                }}
                placeholder={
                  aaNewProjectPaths.length === 0
                    ? "Project path (e.g. /home/user/my-project)"
                    : "Add another project path..."
                }
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
                  onClick={() => addPendingProjectPath(aaNewPathInput)}
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

      <div className="border-t border-cc-border pt-4">
        <AutoApprovalDebugPanel />
      </div>
    </CollapsibleSection>
  );
}
