import {
  SHORTCUT_ACTIONS,
  SHORTCUT_PRESET_OPTIONS,
  formatShortcut,
  getEffectiveShortcutBinding,
  getShortcutPresetBindings,
  type ShortcutActionId,
  type ShortcutSettings,
} from "../shortcuts.js";
import { CollapsibleSection } from "./CollapsibleSection.js";

export function SettingsShortcutSection({
  shortcutSettings,
  setShortcutsEnabled,
  setShortcutPreset,
  setShortcutOverride,
  resetShortcutOverrides,
  recordingShortcutActionId,
  setRecordingShortcutActionId,
  shortcutPlatform,
}: {
  shortcutSettings: ShortcutSettings;
  setShortcutsEnabled: (enabled: boolean) => void;
  setShortcutPreset: (preset: ShortcutSettings["preset"]) => void;
  setShortcutOverride: (actionId: ShortcutActionId, binding: string | null | undefined) => void;
  resetShortcutOverrides: () => void;
  recordingShortcutActionId: ShortcutActionId | null;
  setRecordingShortcutActionId: (actionId: ShortcutActionId | null) => void;
  shortcutPlatform?: string;
}) {
  const shortcutPresetBindings = getShortcutPresetBindings(shortcutSettings.preset);
  const shortcutPresetIsCustom = SHORTCUT_ACTIONS.some(
    (action) =>
      Object.prototype.hasOwnProperty.call(shortcutSettings.overrides, action.id) &&
      shortcutSettings.overrides[action.id] !== shortcutPresetBindings[action.id],
  );

  return (
    <CollapsibleSection
      id="shortcuts"
      title="Shortcuts"
      description="Keyboard shortcuts stay off by default. Choose a preset, then optionally override individual actions."
    >
      <button
        type="button"
        onClick={() => setShortcutsEnabled(!shortcutSettings.enabled)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
      >
        <span>Enabled</span>
        <span className="text-xs text-cc-muted">{shortcutSettings.enabled ? "On" : "Off"}</span>
      </button>

      {shortcutSettings.enabled ? (
        <>
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="shortcut-preset">
              Preset
            </label>
            <select
              id="shortcut-preset"
              value={shortcutSettings.preset}
              onChange={(e) => setShortcutPreset(e.target.value as ShortcutSettings["preset"])}
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
            >
              {SHORTCUT_PRESET_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-cc-muted">
              {SHORTCUT_PRESET_OPTIONS.find((option) => option.id === shortcutSettings.preset)?.description}
            </p>
            {shortcutPresetIsCustom && (
              <p className="mt-1 text-xs text-cc-primary">Individual actions below are overriding this preset.</p>
            )}
          </div>

          <div className="rounded-xl border border-cc-border overflow-hidden">
            {SHORTCUT_ACTIONS.map((action, index) => {
              const effectiveBinding = getEffectiveShortcutBinding(shortcutSettings, action.id);
              const hasOverride = Object.prototype.hasOwnProperty.call(shortcutSettings.overrides, action.id);
              const isOffOverride = shortcutSettings.overrides[action.id] === null;
              const isRecording = recordingShortcutActionId === action.id;
              return (
                <div
                  key={action.id}
                  className={`${index > 0 ? "border-t border-cc-border" : ""} px-3 py-3 bg-cc-hover/30 space-y-2`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-cc-fg">{action.label}</div>
                      <p className="mt-0.5 text-xs text-cc-muted">{action.description}</p>
                    </div>
                    <span className="shrink-0 text-xs font-medium text-cc-primary">
                      {effectiveBinding ? formatShortcut(effectiveBinding, shortcutPlatform) : "Off"}
                    </span>
                  </div>
                  {isRecording ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-cc-primary/35 bg-cc-primary/10 px-3 py-2 text-xs">
                      <span className="text-cc-primary">Press a shortcut for {action.label}. Esc cancels.</span>
                      <button
                        type="button"
                        onClick={() => setRecordingShortcutActionId(null)}
                        className="px-2 py-1 rounded bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setRecordingShortcutActionId(action.id)}
                        className="px-3 py-2 rounded-lg text-xs font-medium bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                      >
                        {hasOverride ? "Record new shortcut" : "Record shortcut"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShortcutOverride(action.id, null)}
                        className="px-3 py-2 rounded-lg text-xs font-medium bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                      >
                        Off
                      </button>
                      <button
                        type="button"
                        onClick={() => setShortcutOverride(action.id, undefined)}
                        disabled={!hasOverride}
                        className="px-3 py-2 rounded-lg text-xs font-medium bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Use preset default
                      </button>
                      {hasOverride && (
                        <span className="text-[11px] text-cc-muted">
                          {isOffOverride ? "Shortcut disabled for this action" : "Custom override active"}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-cc-muted">
              Hover-enabled controls will show shortcut hints only while shortcuts are on.
            </p>
            <button
              type="button"
              onClick={resetShortcutOverrides}
              className="px-3 py-2 rounded-lg text-xs font-medium bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
            >
              Reset Overrides
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-cc-muted">Enable shortcuts to edit presets and bindings.</p>
      )}
    </CollapsibleSection>
  );
}
