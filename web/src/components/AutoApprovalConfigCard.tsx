import { useEffect, useState } from "react";
import { api, type AutoApprovalConfig } from "../api.js";
import { FolderPicker } from "./FolderPicker.js";

export function AutoApprovalConfigCard({ config, onUpdate }: { config: AutoApprovalConfig; onUpdate: () => void }) {
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [criteria, setCriteria] = useState(config.criteria);
  const [label, setLabel] = useState(config.label);
  const [paths, setPaths] = useState<string[]>(
    config.projectPaths?.length ? config.projectPaths : [config.projectPath],
  );
  const [enabled, setEnabled] = useState(config.enabled);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [newPath, setNewPath] = useState("");
  const [showPathPicker, setShowPathPicker] = useState(false);
  const allPaths = config.projectPaths?.length ? config.projectPaths : [config.projectPath];
  const criteriaPreview =
    config.criteria.length > 240 ? `${config.criteria.slice(0, 240).trimEnd()}...` : config.criteria;

  useEffect(() => {
    setEnabled(config.enabled);
    if (!isEditModalOpen) {
      setLabel(config.label);
      setCriteria(config.criteria);
      setPaths(config.projectPaths?.length ? config.projectPaths : [config.projectPath]);
      setNewPath("");
      setError("");
      setShowPathPicker(false);
    }
  }, [config, isEditModalOpen]);

  async function handleSave() {
    const validPaths = paths.filter((p) => p.trim());
    if (validPaths.length === 0) {
      setError("At least one project path is required");
      return;
    }
    if (!label.trim()) {
      setError("Label is required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.updateAutoApprovalConfig(config.slug, {
        label: label.trim(),
        criteria,
        projectPaths: validPaths,
      });
      setIsEditModalOpen(false);
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

  function openEditModal() {
    setLabel(config.label);
    setCriteria(config.criteria);
    setPaths(config.projectPaths?.length ? config.projectPaths : [config.projectPath]);
    setNewPath("");
    setError("");
    setShowPathPicker(false);
    setIsEditModalOpen(true);
  }

  function closeEditModal() {
    if (saving) return;
    setIsEditModalOpen(false);
    setShowPathPicker(false);
    setError("");
  }

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
          onClick={openEditModal}
          className="text-[10px] text-cc-muted hover:text-cc-fg cursor-pointer"
        >
          Edit
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

      {allPaths.length > 1 && (
        <div className="space-y-0.5">
          {allPaths.map((p, i) => (
            <div key={i} className="text-[10px] text-cc-muted font-mono-code truncate" title={p}>
              {p}
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-cc-muted whitespace-pre-wrap">{criteriaPreview}</p>

      {isEditModalOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/50 px-3 py-4"
          onClick={closeEditModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Edit auto-approval rule"
            className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-xl border border-cc-border bg-cc-bg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-cc-border px-4 py-3">
              <h3 className="text-sm font-semibold text-cc-fg">Edit Auto-Approval Rule</h3>
              <button
                type="button"
                onClick={closeEditModal}
                disabled={saving}
                className="text-xs text-cc-muted hover:text-cc-fg disabled:opacity-50 cursor-pointer"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 overflow-y-auto px-4 py-4">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                aria-label="Rule label"
                placeholder="Label"
                className="w-full px-2.5 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50"
              />

              <div className="space-y-1.5">
                <span className="text-xs text-cc-muted">Project Paths</span>
                {paths.map((p, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span
                      className="flex-1 px-2.5 py-1.5 text-xs font-mono-code bg-cc-hover rounded truncate"
                      title={p}
                    >
                      {p}
                    </span>
                    <button
                      type="button"
                      onClick={() => removePath(i)}
                      disabled={paths.length <= 1}
                      className="text-xs text-cc-error/60 hover:text-cc-error cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed px-1.5"
                      title="Remove path"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    aria-label="Add project path"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addPath();
                      }
                    }}
                    placeholder="Add another project path..."
                    className="flex-1 px-2.5 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPathPicker(true)}
                    className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                    title="Browse folders"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={addPath}
                    disabled={!newPath.trim()}
                    className="px-2 py-1 text-xs text-cc-primary hover:text-cc-primary-hover cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
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

              <div className="space-y-1.5">
                <span className="text-xs text-cc-muted">Criteria</span>
                <textarea
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                  aria-label="Rule criteria"
                  rows={12}
                  className="w-full px-2.5 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50 resize-y min-h-[220px]"
                />
              </div>

              {error && <p className="text-xs text-cc-error">{error}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-cc-border px-4 py-3">
              <button
                type="button"
                onClick={closeEditModal}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg disabled:opacity-50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSave}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white disabled:opacity-50 transition-colors cursor-pointer"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
