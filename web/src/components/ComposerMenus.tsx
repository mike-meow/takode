import type { RefObject } from "react";
import type { CommandItem, ReferenceSuggestion } from "./composer-reference-utils.js";

type MentionResult = { relativePath: string; fileName: string };

export function ComposerMenus({
  slashMenuOpen,
  filteredCommands,
  menuRef,
  slashMenuIndex,
  selectCommand,
  dollarMenuOpen,
  filteredDollarCommands,
  dollarMenuRef,
  dollarMenuIndex,
  referenceMenuOpen,
  filteredReferenceSuggestions,
  referenceMenuRef,
  referenceMenuIndex,
  referenceKind,
  referenceQuery,
  selectReference,
  mentionMenuOpen,
  mentionResults,
  mentionMenuRef,
  mentionIndex,
  mentionQuery,
  mentionLoading,
  selectMention,
}: {
  slashMenuOpen: boolean;
  filteredCommands: CommandItem[];
  menuRef: RefObject<HTMLDivElement | null>;
  slashMenuIndex: number;
  selectCommand: (cmd: CommandItem) => void;
  dollarMenuOpen: boolean;
  filteredDollarCommands: CommandItem[];
  dollarMenuRef: RefObject<HTMLDivElement | null>;
  dollarMenuIndex: number;
  referenceMenuOpen: boolean;
  filteredReferenceSuggestions: ReferenceSuggestion[];
  referenceMenuRef: RefObject<HTMLDivElement | null>;
  referenceMenuIndex: number;
  referenceKind: "quest" | "session" | null;
  referenceQuery: string;
  selectReference: (suggestion: ReferenceSuggestion) => void;
  mentionMenuOpen: boolean;
  mentionResults: MentionResult[];
  mentionMenuRef: RefObject<HTMLDivElement | null>;
  mentionIndex: number;
  mentionQuery: string;
  mentionLoading: boolean;
  selectMention: (result: MentionResult) => void;
}) {
  return (
    <>
      {slashMenuOpen && filteredCommands.length > 0 && (
        <div
          ref={menuRef}
          className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
        >
          {filteredCommands.map((cmd, i) => (
            <button
              key={`${cmd.type}-${cmd.name}`}
              data-cmd-index={i}
              onClick={() => selectCommand(cmd)}
              className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                i === slashMenuIndex ? "bg-cc-hover" : "hover:bg-cc-hover/50"
              }`}
            >
              <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                {cmd.type === "skill" ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="w-3.5 h-3.5"
                  >
                    <path d="M5 12L10 4" strokeLinecap="round" />
                  </svg>
                )}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-[13px] font-medium text-cc-fg">/{cmd.name}</span>
                <span className="ml-2 text-[11px] text-cc-muted">{cmd.type}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {dollarMenuOpen && !slashMenuOpen && (
        <div
          ref={dollarMenuRef}
          className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
        >
          {filteredDollarCommands.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-cc-muted">No skills or apps found</div>
          ) : (
            filteredDollarCommands.map((cmd, i) => (
              <button
                key={`${cmd.type}-${cmd.name}-${cmd.insertText}`}
                data-dollar-index={i}
                onClick={() => selectCommand(cmd)}
                className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                  i === dollarMenuIndex ? "bg-cc-hover" : "hover:bg-cc-hover/50"
                }`}
              >
                <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                  {cmd.type === "app" ? (
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="w-3.5 h-3.5"
                    >
                      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
                      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
                      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
                      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                    </svg>
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[13px] font-medium text-cc-fg truncate">${cmd.name}</span>
                    <span className="text-[11px] text-cc-muted shrink-0">{cmd.type}</span>
                  </div>
                  {cmd.description && <div className="mt-0.5 text-[11px] text-cc-muted truncate">{cmd.description}</div>}
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {referenceMenuOpen && !slashMenuOpen && !dollarMenuOpen && (
        <div
          ref={referenceMenuRef}
          className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
        >
          {filteredReferenceSuggestions.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-cc-muted">
              No {referenceKind === "quest" ? "quests" : "sessions"} found for "
              {referenceKind === "quest" ? `q-${referenceQuery}` : `#${referenceQuery}`}"
            </div>
          ) : (
            filteredReferenceSuggestions.map((suggestion, i) => (
              <button
                key={suggestion.key}
                data-reference-index={i}
                onClick={() => selectReference(suggestion)}
                className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                  i === referenceMenuIndex ? "bg-cc-hover" : "hover:bg-cc-hover/50"
                }`}
              >
                <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                  {suggestion.kind === "quest" ? (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                      <path d="M5 3.5h6" strokeLinecap="round" />
                      <path d="M5 8h6" strokeLinecap="round" />
                      <path d="M5 12.5h4" strokeLinecap="round" />
                      <rect x="2.5" y="1.75" width="11" height="12.5" rx="2" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                      <circle cx="8" cy="8" r="5.5" />
                      <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[13px] font-medium text-cc-fg">{suggestion.rawRef}</span>
                    <span className="shrink-0 text-[11px] text-cc-muted">{suggestion.kind}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-cc-muted">{suggestion.preview}</div>
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {mentionMenuOpen && !slashMenuOpen && !dollarMenuOpen && !referenceMenuOpen && (
        <div
          ref={mentionMenuRef}
          className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
        >
          {mentionQuery.length < 3 ? (
            <div className="px-3 py-2.5 text-[12px] text-cc-muted flex items-center gap-2">
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="w-3.5 h-3.5 shrink-0 opacity-50"
              >
                <circle cx="6.5" cy="6.5" r="4.5" />
                <path d="M10 10l4 4" strokeLinecap="round" />
              </svg>
              Type at least 3 characters to search files...
            </div>
          ) : mentionLoading && mentionResults.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-cc-muted flex items-center gap-2">
              <span className="w-3 h-3 border-2 border-cc-muted/30 border-t-cc-muted rounded-full animate-spin shrink-0" />
              Searching...
            </div>
          ) : mentionResults.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-cc-muted">No files found for "{mentionQuery}"</div>
          ) : (
            mentionResults.map((result, i) => (
              <button
                key={result.relativePath}
                data-mention-index={i}
                onClick={() => selectMention(result)}
                className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                  i === mentionIndex ? "bg-cc-hover" : "hover:bg-cc-hover/50"
                }`}
              >
                <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                    <path d="M3 1.5A1.5 1.5 0 014.5 0h4.586a1.5 1.5 0 011.06.44l2.415 2.414A1.5 1.5 0 0113 3.914V14.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 14.5v-13z" />
                  </svg>
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-cc-fg">{result.fileName}</span>
                  <span className="ml-2 text-[11px] text-cc-muted truncate">{result.relativePath}</span>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </>
  );
}
