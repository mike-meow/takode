import { useStore } from "../store.js";
import { retryPendingCreation, cancelPendingCreation } from "../utils/pending-creation.js";
import { YarnBallSpinner } from "./CatIcons.js";
import type { CreationProgressEvent } from "../api.js";

interface Props {
  pendingId: string;
}

/**
 * Inline view shown in the main content area when a pending session is selected.
 * Replaces the old full-screen SessionLaunchOverlay — same visuals, but inline
 * so the user can navigate the sidebar while creation runs in the background.
 */
export function SessionCreationView({ pendingId }: Props) {
  const pending = useStore((s) => s.pendingSessions.get(pendingId));

  if (!pending) {
    return (
      <div className="flex-1 flex items-center justify-center text-cc-muted text-sm">
        Session not found
      </div>
    );
  }

  const { progress, error, status, backend } = pending;
  const logoSrc = backend === "codex" ? "/logo-codex.svg" : "/logo.png";
  const isCreating = status === "creating";
  const hasError = status === "error";
  const isAnyInProgress = progress.some((s) => s.status === "in_progress");

  // Current step label for the subtitle
  const currentStep = [...progress].reverse().find((s) => s.status === "in_progress");
  const lastDone = [...progress].reverse().find((s) => s.status === "done");
  const subtitle = hasError
    ? "Something went wrong"
    : status === "succeeded"
      ? "Launching session..."
      : currentStep?.label || lastDone?.label || "Preparing...";

  return (
    <div className="flex-1 flex flex-col items-center justify-center">
      {/* Pulsing logo */}
      <div className="relative mb-8">
        {isAnyInProgress && !hasError && (
          <div className="absolute inset-0 -m-4 rounded-full bg-cc-primary/10 animate-pulse" />
        )}
        <img
          src={logoSrc}
          alt="Creating session"
          className={`w-20 h-20 relative z-10 transition-transform duration-500 ${
            isAnyInProgress && !hasError ? "scale-110" : ""
          } ${hasError ? "opacity-40 grayscale" : ""}`}
        />
        {/* Spinner ring around logo */}
        {isAnyInProgress && !hasError && (
          <div className="absolute -inset-3 z-0">
            <svg className="w-full h-full animate-spin-slow" viewBox="0 0 100 100">
              <circle
                cx="50" cy="50" r="46"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="60 230"
                strokeLinecap="round"
                className="text-cc-primary/40"
              />
            </svg>
          </div>
        )}
        {/* Success ring */}
        {status === "succeeded" && (
          <div className="absolute -inset-3 z-0 rounded-full border-2 border-cc-success/30" />
        )}
      </div>

      {/* Status text */}
      <p className={`text-sm font-medium mb-6 transition-colors ${
        hasError ? "text-cc-error" : "text-cc-fg"
      }`}>
        {subtitle}
      </p>

      {/* Step list */}
      <StepList steps={progress} />

      {/* Error detail box */}
      {error && (
        <div className="mt-5 w-full max-w-xs px-4">
          <div className="px-3 py-2.5 rounded-lg bg-cc-error/5 border border-cc-error/20">
            <p className="text-[11px] text-cc-error whitespace-pre-wrap font-mono-code leading-relaxed">
              {error}
            </p>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-6 flex items-center gap-3">
        {hasError && (
          <button
            onClick={() => retryPendingCreation(pendingId)}
            className="px-4 py-1.5 text-xs font-medium rounded-lg bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25 transition-colors cursor-pointer"
          >
            Retry
          </button>
        )}
        <button
          onClick={() => cancelPendingCreation(pendingId)}
          className="px-4 py-1.5 text-xs font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg hover:bg-cc-border transition-colors cursor-pointer"
        >
          {hasError ? "Dismiss" : "Cancel"}
        </button>
      </div>

      {/* Progress bar at the bottom */}
      {isCreating && progress.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-cc-border/30">
          <div
            className="h-full bg-cc-primary/60 transition-all duration-500 ease-out"
            style={{
              width: `${Math.round(
                (progress.filter((s) => s.status === "done").length / Math.max(progress.length, 1)) * 100,
              )}%`,
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Reusable step list used by both SessionCreationView and Playground mocks.
 */
export function StepList({ steps }: { steps: CreationProgressEvent[] }) {
  return (
    <div className="w-full max-w-xs space-y-2 px-4">
      {steps.map((step, i) => (
        <div
          key={step.step}
          className="flex items-center gap-3 transition-all duration-300"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          {/* Icon */}
          <div className="w-5 h-5 flex items-center justify-center shrink-0">
            {step.status === "in_progress" && (
              <YarnBallSpinner className="w-4 h-4 text-cc-primary" />
            )}
            {step.status === "done" && (
              <div className="w-5 h-5 rounded-full bg-cc-success/15 flex items-center justify-center">
                <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 text-cc-success">
                  <path
                    d="M13.25 4.75L6 12 2.75 8.75"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            )}
            {step.status === "error" && (
              <div className="w-5 h-5 rounded-full bg-cc-error/15 flex items-center justify-center">
                <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 text-cc-error">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            )}
          </div>

          {/* Label */}
          <span
            className={`text-xs transition-colors duration-200 ${
              step.status === "in_progress"
                ? "text-cc-fg font-medium"
                : step.status === "done"
                  ? "text-cc-muted"
                  : "text-cc-error font-medium"
            }`}
          >
            {step.label}
          </span>

          {/* Detail */}
          {step.detail && step.status === "in_progress" && (
            <span className="text-[10px] text-cc-muted truncate ml-auto max-w-[120px]">
              {step.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
