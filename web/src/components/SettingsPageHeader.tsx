export function SettingsPageHeader({ embedded, onBack }: { embedded: boolean; onBack: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-2">
      <div>
        <h1 className="text-xl font-semibold text-cc-fg">Settings</h1>
        <p className="mt-1 text-sm text-cc-muted">Configure notifications, appearance, and workspace defaults.</p>
      </div>
      {!embedded && (
        <button
          onClick={onBack}
          className="px-3 py-1.5 rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          Back
        </button>
      )}
    </div>
  );
}
