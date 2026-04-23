import type { RefObject, ReactNode } from "react";
import { CODEX_REASONING_EFFORTS, formatModel, type ModelOption } from "../utils/backends.js";
import { CatPawAvatar } from "./CatIcons.js";

function PaperPlaneIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
    </svg>
  );
}

export function ComposerMetaToolbar({
  sessionId,
  sessionView,
  diffLinesAdded,
  diffLinesRemoved,
  isCodex,
  isConnected,
  showModelDropdown,
  setShowModelDropdown,
  modelDropdownRef,
  claudeModelOptions,
  codexModelOptions,
  onSelectModel,
  showCodexReasoningDropdown,
  setShowCodexReasoningDropdown,
  codexReasoningDropdownRef,
  codexReasoningEffort,
  onSelectCodexReasoning,
  isPlan,
  cycleMode,
  askConfirmRef,
  toggleAskPermission,
  askPermission,
  showAskConfirm,
  setShowAskConfirm,
  confirmAskPermissionChange,
  collapseAllButton,
  onOpenFilePicker,
  warmMicrophone,
  voiceSupported,
  toggleVoiceUnsupportedInfo,
  handleMicClick,
  voiceButtonDisabled,
  isPreparing,
  isRecording,
  voiceButtonTitle,
  canSend,
  isRunning,
  handleInterrupt,
  handleSend,
  activePendingUploadStage,
  sendButtonTitle,
  sendPressing,
}: {
  sessionId: string;
  sessionView: {
    gitBranch?: string;
    model?: string;
    isContainerized?: boolean;
    gitAhead: number;
    gitBehind: number;
  };
  diffLinesAdded: number;
  diffLinesRemoved: number;
  isCodex: boolean;
  isConnected: boolean;
  showModelDropdown: boolean;
  setShowModelDropdown: (open: boolean) => void;
  modelDropdownRef: RefObject<HTMLDivElement | null>;
  claudeModelOptions: ModelOption[];
  codexModelOptions: ModelOption[];
  onSelectModel: (model: string) => void;
  showCodexReasoningDropdown: boolean;
  setShowCodexReasoningDropdown: (open: boolean) => void;
  codexReasoningDropdownRef: RefObject<HTMLDivElement | null>;
  codexReasoningEffort: string;
  onSelectCodexReasoning: (effort: string) => void;
  isPlan: boolean;
  cycleMode: () => void;
  askConfirmRef: RefObject<HTMLDivElement | null>;
  toggleAskPermission: () => void;
  askPermission: boolean;
  showAskConfirm: boolean;
  setShowAskConfirm: (open: boolean) => void;
  confirmAskPermissionChange: () => void;
  collapseAllButton: ReactNode;
  onOpenFilePicker: () => void;
  warmMicrophone: () => void;
  voiceSupported: boolean;
  toggleVoiceUnsupportedInfo: (expandComposerOnReveal?: boolean) => void;
  handleMicClick: () => void;
  voiceButtonDisabled: boolean;
  isPreparing: boolean;
  isRecording: boolean;
  voiceButtonTitle: string;
  canSend: boolean;
  isRunning: boolean;
  handleInterrupt: () => void;
  handleSend: () => void;
  activePendingUploadStage?: string;
  sendButtonTitle: string;
  sendPressing: boolean;
}) {
  return (
    <div data-testid="composer-footer-toolbar" className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={cycleMode}
            disabled={!isConnected}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors select-none ${
              !isConnected
                ? "opacity-30 cursor-not-allowed text-cc-muted"
                : isPlan
                  ? "bg-cc-primary/15 text-cc-primary cursor-pointer"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
            }`}
            title={
              isPlan
                ? "Plan mode: agent creates a plan before executing (Shift+Tab to toggle)"
                : "Agent mode: executes tools directly (Shift+Tab to toggle)"
            }
          >
            {isPlan ? (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M2 3.5h12v1H2zm0 4h8v1H2zm0 4h10v1H2z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path
                  d="M2.5 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
                <path
                  d="M8.5 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            )}
            <span>{isPlan ? "Plan" : "Agent"}</span>
          </button>

          <div className="relative" ref={askConfirmRef}>
            <button
              onClick={toggleAskPermission}
              disabled={!isConnected}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors select-none ${
                !isConnected ? "opacity-30 cursor-not-allowed text-cc-muted" : "cursor-pointer hover:bg-cc-hover"
              }`}
              title={
                askPermission
                  ? "Permissions: asking before tool use (click to change)"
                  : "Permissions: auto-approving tool use (click to change)"
              }
            >
              {askPermission ? (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-primary">
                  <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                  <path
                    d="M6.5 8.5L7.5 9.5L10 7"
                    stroke="white"
                    strokeWidth="1.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  className="w-4 h-4 text-cc-muted"
                >
                  <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                </svg>
              )}
            </button>
            {showAskConfirm && (
              <div
                data-testid="composer-permission-popover"
                className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 p-3"
              >
                <p className="text-xs text-cc-fg mb-1 font-medium">
                  {askPermission ? "Disable permission prompts?" : "Enable permission prompts?"}
                </p>
                <p className="text-[11px] text-cc-muted mb-3 leading-relaxed">
                  This will restart the CLI session. Any in-progress operation will be interrupted. Your conversation
                  will be preserved.
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => setShowAskConfirm(false)}
                    className="px-2.5 py-1 text-[11px] rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmAskPermissionChange}
                    className="px-2.5 py-1 text-[11px] rounded-md bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25 transition-colors cursor-pointer font-medium"
                  >
                    Restart
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0">{collapseAllButton}</div>

        {(sessionView.gitBranch || sessionView.model) && (
          <div data-testid="composer-footer-meta" className="flex min-w-0 items-center gap-2 text-[11px] text-cc-muted">
            {sessionView.gitBranch && (
              <span className="flex min-w-0 items-center gap-1 truncate">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                </svg>
                <span className="truncate max-w-[92px] sm:max-w-[160px]">{sessionView.gitBranch}</span>
                {sessionView.isContainerized && (
                  <span className="rounded bg-blue-500/10 px-1 text-[10px] text-blue-400">container</span>
                )}
              </span>
            )}
            {(sessionView.gitAhead > 0 || sessionView.gitBehind > 0) && (
              <span className="flex shrink-0 items-center gap-0.5 text-[10px]">
                {sessionView.gitAhead > 0 && <span className="text-green-500">{sessionView.gitAhead}&#8593;</span>}
                {sessionView.gitBehind > 0 && <span className="text-cc-warning">{sessionView.gitBehind}&#8595;</span>}
              </span>
            )}
            {(diffLinesAdded > 0 || diffLinesRemoved > 0) && (
              <span className="flex shrink-0 items-center gap-1">
                <span className="text-green-500">+{diffLinesAdded}</span>
                <span className="text-red-400">-{diffLinesRemoved}</span>
              </span>
            )}
            {sessionView.model && (
              <>
                {sessionView.gitBranch && <span className="shrink-0 text-cc-muted/40">&middot;</span>}
                {!isCodex ? (
                  <div className="relative min-w-0" ref={modelDropdownRef}>
                    <button
                      onClick={() => setShowModelDropdown(!showModelDropdown)}
                      disabled={!isConnected}
                      className={`flex min-w-0 items-center gap-0.5 font-mono-code transition-colors select-none ${
                        !isConnected ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:text-cc-fg"
                      }`}
                      title={`Model: ${sessionView.model} (click to change)`}
                    >
                      <span className="truncate">{formatModel(sessionView.model)}</span>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    </button>
                    {showModelDropdown && (
                      <div
                        data-testid="composer-model-menu"
                        className="absolute left-0 bottom-full z-10 mb-1 max-h-64 w-52 overflow-hidden overflow-y-auto rounded-[10px] border border-cc-border bg-cc-card py-1 shadow-lg"
                      >
                        {claudeModelOptions.map((m) => (
                          <button
                            key={m.value}
                            onClick={() => {
                              onSelectModel(m.value);
                              setShowModelDropdown(false);
                            }}
                            className={`w-full cursor-pointer px-3 py-2 text-left text-xs transition-colors hover:bg-cc-hover ${
                              m.value === sessionView.model ? "font-medium text-cc-primary" : "text-cc-fg"
                            }`}
                          >
                            <span className="mr-1.5">{m.icon}</span>
                            {m.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="relative min-w-0" ref={modelDropdownRef}>
                      <button
                        onClick={() => setShowModelDropdown(!showModelDropdown)}
                        disabled={!isConnected}
                        className={`flex min-w-0 items-center gap-0.5 font-mono-code transition-colors select-none ${
                          !isConnected ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:text-cc-fg"
                        }`}
                        title={`Model: ${sessionView.model} (relaunch required)`}
                      >
                        <span className="truncate">{formatModel(sessionView.model)}</span>
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                          <path d="M4 6l4 4 4-4" />
                        </svg>
                      </button>
                      {showModelDropdown && (
                        <div
                          data-testid="composer-model-menu"
                          className="absolute left-0 bottom-full z-10 mb-1 max-h-64 w-52 overflow-hidden overflow-y-auto rounded-[10px] border border-cc-border bg-cc-card py-1 shadow-lg"
                        >
                          {codexModelOptions.map((m) => (
                            <button
                              key={m.value}
                              onClick={() => {
                                onSelectModel(m.value);
                                setShowModelDropdown(false);
                              }}
                              className={`w-full cursor-pointer px-3 py-2 text-left text-xs transition-colors hover:bg-cc-hover ${
                                m.value === sessionView.model ? "font-medium text-cc-primary" : "text-cc-fg"
                              }`}
                            >
                              <span className="mr-1.5">{m.icon}</span>
                              {m.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 text-cc-muted/40">&middot;</span>
                    <div className="relative shrink-0" ref={codexReasoningDropdownRef}>
                      <button
                        onClick={() => setShowCodexReasoningDropdown(!showCodexReasoningDropdown)}
                        disabled={!isConnected}
                        className={`flex items-center gap-1 transition-colors select-none ${
                          !isConnected ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:text-cc-fg"
                        }`}
                        title="Reasoning effort (relaunch required)"
                      >
                        <span>
                          {CODEX_REASONING_EFFORTS.find((x) => x.value === codexReasoningEffort)?.label.toLowerCase() ||
                            "default"}
                        </span>
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                          <path d="M4 6l4 4 4-4" />
                        </svg>
                      </button>
                      {showCodexReasoningDropdown && (
                        <div
                          data-testid="composer-reasoning-menu"
                          className="absolute left-0 bottom-full z-10 mb-1 w-40 overflow-hidden rounded-[10px] border border-cc-border bg-cc-card py-1 shadow-lg"
                        >
                          {CODEX_REASONING_EFFORTS.map((effort) => (
                            <button
                              key={effort.value || "default"}
                              onClick={() => {
                                onSelectCodexReasoning(effort.value);
                                setShowCodexReasoningDropdown(false);
                              }}
                              className={`w-full cursor-pointer px-3 py-2 text-left text-xs transition-colors hover:bg-cc-hover ${
                                effort.value === codexReasoningEffort ? "font-medium text-cc-primary" : "text-cc-fg"
                              }`}
                            >
                              {effort.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3 sm:gap-1">
        <button
          onClick={onOpenFilePicker}
          disabled={!isConnected}
          className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-lg transition-colors ${
            isConnected
              ? "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
              : "text-cc-muted opacity-30 cursor-not-allowed"
          }`}
          title="Upload image"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-5 h-5 sm:w-4 sm:h-4"
          >
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
            <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          onPointerEnter={warmMicrophone}
          onClick={!voiceSupported ? () => toggleVoiceUnsupportedInfo(false) : handleMicClick}
          disabled={voiceButtonDisabled}
          aria-label="Voice input"
          aria-disabled={!voiceSupported || voiceButtonDisabled}
          className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-lg transition-colors ${
            !voiceSupported || voiceButtonDisabled
              ? "text-cc-muted opacity-30 cursor-not-allowed"
              : isPreparing
                ? "text-cc-warning bg-cc-warning/10 cursor-wait"
                : isRecording
                  ? "text-red-500 bg-red-500/10 hover:bg-red-500/20 cursor-pointer"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
          }`}
          title={voiceButtonTitle}
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-5 h-5 sm:w-4 sm:h-4 ${isRecording || isPreparing ? "animate-pulse" : ""}`}
          >
            <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
            <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
          </svg>
        </button>

        {!canSend && isRunning ? (
          <button
            onClick={handleInterrupt}
            className="flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-full transition-colors bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
            title="Stop generation"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-full transition-colors ${
              canSend
                ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                : "bg-cc-hover text-cc-muted cursor-not-allowed"
            } ${sendPressing ? "animate-[send-morph_500ms_ease-out]" : ""}`}
            title={activePendingUploadStage === "uploading" ? "Uploading image" : sendButtonTitle}
          >
            {sendPressing ? (
              <CatPawAvatar className="w-5 h-5 sm:w-4 sm:h-4" />
            ) : (
              <PaperPlaneIcon className="w-5 h-5 sm:w-4 sm:h-4" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
