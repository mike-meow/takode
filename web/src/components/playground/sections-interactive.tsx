import { useState } from "react";
import { NotificationMarker } from "../MessageBubble.js";
import { BoardBlock } from "../BoardBlock.js";
import type { BoardRowData } from "../BoardTable.js";
import { CatPawAvatar } from "../CatIcons.js";
import { ReplyChip } from "../Composer.js";
import { WorkBoardBar } from "../WorkBoardBar.js";
import { TimerChip } from "../TimerWidget.js";
import { NotificationChip } from "../NotificationChip.js";
import { UserReplyChip } from "../MessageBubble.js";
import { useStore } from "../../store.js";
import { PlaygroundQuestStatusPanelDemo } from "./PlaygroundQuestStatusPanelDemo.js";
import {
  Card,
  PlaygroundAddressedSuggestedAnswerNotificationMarker,
  PlaygroundBoardWithOriginalCommand,
  PlaygroundDedupedNotificationMessage,
  PlaygroundHoverCrossLinkDemo,
  PlaygroundMessageLinkHoverDemo,
  PlaygroundReviewNotificationMarker,
  PlaygroundSectionGroup,
  PlaygroundSelectionContextMenu,
  PlaygroundSuggestedAnswerNotificationMarker,
  Section,
  TimerModalDemo,
} from "./shared.js";

export function PlaygroundInteractiveSections() {
  const [boardOpenThreadKeys, setBoardOpenThreadKeys] = useState(["q-42", "q-55", "q-61", "q-77", "q-88"]);
  const [boardPreviewThreadKey, setBoardPreviewThreadKey] = useState("main");

  return (
    <PlaygroundSectionGroup groupId="interactive">
      {/* ─── Composer ──────────────────────────────── */}
      <Section title="Composer" description="Message input bar with mode toggle, image upload, and send/stop buttons">
        <div className="max-w-3xl">
          <Card label="Connected — code mode">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-visible">
                <div className="px-4 pt-3 pb-2">
                  <div className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-cc-border/80 bg-cc-hover/70 px-2 py-1 text-[11px] text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0 opacity-70">
                      <path d="M3.75 1.5A2.25 2.25 0 001.5 3.75v8.5A2.25 2.25 0 003.75 14.5h8.5a2.25 2.25 0 002.25-2.25v-5a.75.75 0 00-1.5 0v5A.75.75 0 0112.25 13h-8.5a.75.75 0 01-.75-.75v-8.5A.75.75 0 013.75 3h5a.75.75 0 000-1.5h-5z" />
                      <path d="M9.53 1.47a.75.75 0 011.06 0l3.94 3.94a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-.33.2l-2.5.63a.75.75 0 01-.91-.91l.63-2.5a.75.75 0 01.2-.33l5.5-5.5z" />
                    </svg>
                    <span className="min-w-0 truncate rounded px-0.5 font-mono-code">OverflowTarget.tsx:438-444</span>
                    <span className="text-cc-muted/60">&middot;</span>
                    <span className="shrink-0">7 lines selected</span>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 hover:bg-cc-border/60 cursor-pointer"
                      aria-label="Dismiss selection"
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      >
                        <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" />
                      </svg>
                    </button>
                  </div>
                </div>
                <textarea
                  readOnly
                  value="Can you refactor the auth module to use JWT?"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
                  <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-cc-muted">
                    <div className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium">
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
                      <span>Agent</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                      <span className="truncate font-mono-code">jiayi</span>
                      <span className="shrink-0 text-cc-muted/40">&middot;</span>
                      <span className="truncate font-mono-code">sonnet-4.5</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Connected — VS Code preview only">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-visible">
                <div className="px-4 pt-3 pb-2">
                  <div className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-cc-border/80 bg-cc-hover/70 px-2 py-1 text-[11px] text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0 opacity-70">
                      <path d="M3.75 1.5A2.25 2.25 0 001.5 3.75v8.5A2.25 2.25 0 003.75 14.5h8.5a2.25 2.25 0 002.25-2.25v-5a.75.75 0 00-1.5 0v5A.75.75 0 0112.25 13h-8.5a.75.75 0 01-.75-.75v-8.5A.75.75 0 013.75 3h5a.75.75 0 000-1.5h-5z" />
                      <path d="M9.53 1.47a.75.75 0 011.06 0l3.94 3.94a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-.33.2l-2.5.63a.75.75 0 01-.91-.91l.63-2.5a.75.75 0 01.2-.33l5.5-5.5z" />
                    </svg>
                    <span className="relative min-w-0">
                      <span className="block truncate rounded px-0.5 font-mono-code text-cc-fg">App.tsx:58</span>
                      <span className="absolute left-0 bottom-full z-20 mb-2 w-max max-w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-cc-border bg-cc-card px-3 py-2 text-[11px] text-cc-fg shadow-lg">
                        <span className="block font-mono-code break-all leading-snug">
                          /Users/stan/Dev/project/web/src/App.tsx
                        </span>
                      </span>
                    </span>
                    <span className="text-cc-muted/60">&middot;</span>
                    <span className="shrink-0">1 line selected</span>
                  </div>
                </div>
                <textarea
                  readOnly
                  value="Does this selection matter?"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
                  <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-cc-muted">
                    <div className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium">
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
                      <span>Agent</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                      <span className="truncate font-mono-code">jiayi</span>
                      <span className="shrink-0 text-cc-muted/40">&middot;</span>
                      <span className="truncate font-mono-code">sonnet-4.5</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Desktop drag-over image attach">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="relative bg-cc-input-bg border border-cc-primary rounded-[14px] overflow-hidden shadow-[0_0_0_3px_rgba(255,122,26,0.12)]">
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border border-dashed border-cc-primary/50 bg-cc-primary/10">
                  <div className="rounded-full border border-cc-primary/25 bg-cc-card/95 px-3 py-1 text-[11px] font-medium text-cc-primary shadow-sm">
                    Drop images to attach
                  </div>
                </div>
                <textarea
                  readOnly
                  value="Investigate this screenshot and attached error."
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
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
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-primary bg-cc-primary/10">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Attachment processing states">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <div className="flex items-center gap-2 px-4 pt-3 text-[11px] text-cc-warning">
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
                  <span>Remove or retry 1 failed image before sending.</span>
                </div>
                <div className="flex items-center gap-2 px-4 pt-3 flex-wrap">
                  <div className="relative">
                    <div className="w-24 h-24 rounded-lg border border-cc-border bg-[linear-gradient(135deg,#4b5563,#111827)]" />
                    <div className="pointer-events-none absolute inset-x-1 bottom-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] text-white">
                      <div className="truncate font-medium">Uploading...</div>
                    </div>
                  </div>
                  <div className="relative">
                    <div className="w-24 h-24 rounded-lg border border-cc-border bg-[linear-gradient(135deg,#7f1d1d,#1f2937)]" />
                    <button
                      type="button"
                      className="absolute left-1.5 top-1.5 rounded-full bg-cc-card/95 px-2 py-1 text-[10px] font-medium text-cc-primary shadow-sm"
                    >
                      Retry
                    </button>
                    <div className="pointer-events-none absolute inset-x-1 bottom-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] text-white">
                      <div className="truncate font-medium">Upload failed</div>
                      <div className="truncate text-white/80">server rejected image</div>
                    </div>
                  </div>
                  <div className="relative">
                    <div className="w-24 h-24 rounded-lg border border-cc-border bg-[linear-gradient(135deg,#0f766e,#111827)]" />
                    <div className="pointer-events-none absolute inset-x-1 bottom-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] text-white">
                      <div className="truncate font-medium">Ready</div>
                    </div>
                  </div>
                </div>
                <textarea
                  readOnly
                  value="Please compare the ready screenshot once the retry succeeds."
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
                  <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-cc-muted">
                    <div className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium">
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
                      <span>Agent</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Codex `$` skill/app picker">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="relative bg-cc-input-bg border border-cc-border rounded-[14px] overflow-visible">
                <div className="absolute left-2 right-2 bottom-full mb-1 rounded-[10px] border border-cc-border bg-cc-card shadow-lg py-1">
                  {[
                    {
                      label: "$doc-coauthoring",
                      kind: "skill",
                      description: "Draft and edit design docs",
                    },
                    {
                      label: "$google-drive",
                      kind: "app",
                      description: "Search and edit Drive files",
                    },
                  ].map((entry, index) => (
                    <div
                      key={entry.label}
                      className={`w-full px-3 py-2 flex items-center gap-2.5 ${index === 0 ? "bg-cc-hover" : ""}`}
                    >
                      <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                        {entry.kind === "app" ? (
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
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-cc-fg">{entry.label}</span>
                          <span className="shrink-0 text-[11px] text-cc-muted">{entry.kind}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-cc-muted">{entry.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <textarea
                  readOnly
                  value="Use $doc"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
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
                    <span>agent</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Quest/session ref autocomplete">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="relative bg-cc-input-bg border border-cc-border rounded-[14px] overflow-visible">
                <div className="absolute left-2 right-2 bottom-full mb-1 rounded-[10px] border border-cc-border bg-cc-card shadow-lg py-1">
                  {[
                    {
                      rawRef: "q-477",
                      kind: "quest",
                      preview: "Autocomplete quest and session refs",
                    },
                    {
                      rawRef: "#687",
                      kind: "session",
                      preview: "Autocomplete quest and session refs",
                    },
                  ].map((entry, index) => (
                    <div
                      key={entry.rawRef}
                      className={`w-full px-3 py-2 flex items-center gap-2.5 ${index === 0 ? "bg-cc-hover" : ""}`}
                    >
                      <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                        {entry.kind === "quest" ? (
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            className="w-3.5 h-3.5"
                          >
                            <path d="M5 3.5h6" strokeLinecap="round" />
                            <path d="M5 8h6" strokeLinecap="round" />
                            <path d="M5 12.5h4" strokeLinecap="round" />
                            <rect x="2.5" y="1.75" width="11" height="12.5" rx="2" />
                          </svg>
                        ) : (
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            className="w-3.5 h-3.5"
                          >
                            <circle cx="8" cy="8" r="5.5" />
                            <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium text-cc-fg">{entry.rawRef}</span>
                          <span className="shrink-0 text-[11px] text-cc-muted">{entry.kind}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-cc-muted">{entry.preview}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
                  {["q-477", "#687"].map((ref) => (
                    <span
                      key={ref}
                      className="inline-flex max-w-[160px] items-center rounded-md border border-cc-border/70 bg-cc-hover/45 px-1.5 py-0.5 font-mono-code text-[11px] leading-4 text-cc-primary"
                    >
                      {ref}
                    </span>
                  ))}
                </div>
                <textarea
                  readOnly
                  value="Follow up on q-477 and sync with #687"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
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
                    <span>agent</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Send pressed — paw morph">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
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
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div
                      className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white animate-[send-morph_500ms_ease-out]"
                      style={{ animationPlayState: "paused", animationDelay: "-150ms" }}
                    >
                      <CatPawAvatar className="w-4 h-4" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Plan mode active">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-primary/40 rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-primary">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <rect x="3" y="3" width="3.5" height="10" rx="0.75" />
                      <rect x="9.5" y="3" width="3.5" height="10" rx="0.75" />
                    </svg>
                    <span>plan</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Mobile reply lock keeps composer expanded">
            <div className="border-t border-cc-border bg-cc-card px-3 py-3">
              <div className="max-w-[430px]">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <ReplyChip
                    previewText="Approve q-460 plan? Re-run all 4 datasets before review."
                    onDismiss={() => {}}
                  />
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-base bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
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
                      <span>agent</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center w-11 h-11 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-5 h-5"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-11 h-11 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Running — stop button visible">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                  style={{ minHeight: "36px" }}
                />
                {/* Git branch info */}
                <div className="flex items-center gap-2 px-4 pb-1 text-[11px] text-cc-muted overflow-hidden">
                  <span className="flex items-center gap-1 truncate min-w-0">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                      <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                    </svg>
                    <span className="truncate">feat/jwt-auth</span>
                    <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1 rounded">container</span>
                  </span>
                  <span className="flex items-center gap-0.5 text-[10px]">
                    <span className="text-green-500">3&#8593;</span>
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="text-green-500">+142</span>
                    <span className="text-red-400">-38</span>
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
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
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-3 sm:gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-cc-error/10 text-cc-error">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <rect x="3" y="3" width="10" height="10" rx="1" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </Section>

      {/* ─── Reply Chip ──────────────────────────────── */}
      <Section
        title="Reply Chip"
        description="Shows which assistant message the user is replying to. Appears above the composer textarea."
      >
        <div className="max-w-3xl">
          <Card label="Short preview text">
            <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
              <ReplyChip previewText="Here's the implementation plan for the reply feature..." onDismiss={() => {}} />
              <div className="px-4 py-3 text-cc-muted text-sm italic">(Composer textarea would be here)</div>
            </div>
          </Card>
          <Card label="Long preview text (truncated)">
            <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
              <ReplyChip
                previewText="This is a much longer preview text that exceeds the typical display width and should be truncated with CSS so it doesn't wrap to multiple lines and break the layout"
                onDismiss={() => {}}
              />
              <div className="px-4 py-3 text-cc-muted text-sm italic">(Composer textarea would be here)</div>
            </div>
          </Card>
        </div>
      </Section>

      {/* ─── Selection Context Menu ──────────────────────────────── */}
      <Section
        title="Selection Context Menu"
        description="Floating context menu shown when the user selects text within an assistant message. Offers quoting and copy options."
      >
        <div className="max-w-3xl">
          <Card label="Menu above selected text">
            <PlaygroundSelectionContextMenu />
          </Card>
        </div>
      </Section>

      {/* ─── User Message Reply Chip ──────────────────────────────── */}
      <Section
        title="User Message Reply Chip"
        description="Read-only reply chip rendered above user message bubble text when the user replied to a specific assistant message."
      >
        <div className="max-w-3xl">
          <Card label="Short reply context">
            <div className="flex justify-end">
              <div className="max-w-[80%] px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                <UserReplyChip previewText="Here's the implementation plan for the reply feature..." />
                <pre className="text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
                  Can you also add keyboard shortcuts for this?
                </pre>
              </div>
            </div>
          </Card>
          <Card label="Long reply context (truncated)">
            <div className="flex justify-end">
              <div className="max-w-[80%] px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                <UserReplyChip previewText="This is a much longer preview text that exceeds the typical display width and should be truncated with CSS to keep the chip compact" />
                <pre className="text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
                  I disagree with this approach. Let me explain why.
                </pre>
              </div>
            </div>
          </Card>
          <Card label="Reply with code in preview">
            <div className="flex justify-end">
              <div className="max-w-[80%] px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                <UserReplyChip previewText={'Here\'s the fix: `const result = await fetchData("api/v2")`'} />
                <pre className="text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
                  This doesn't handle the error case. Can you add a try/catch?
                </pre>
              </div>
            </div>
          </Card>
        </div>
      </Section>

      {/* ─── Notification Marker ──────────────────────────────── */}
      <Section
        title="Notification Marker"
        description="Rendered after assistant message content when a notification was anchored to it via takode notify."
      >
        <div className="max-w-3xl">
          <Card label="needs-input (amber, no summary)">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">I've finished analyzing the logs. There are two approaches we could take:</p>
              <p className="text-cc-muted">1. Increase the timeout globally, or 2. Add retry logic per-request.</p>
              <NotificationMarker category="needs-input" />
            </div>
          </Card>
          <Card label="needs-input with summary">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">I've finished analyzing the logs. There are two approaches we could take:</p>
              <p className="text-cc-muted">1. Increase the timeout globally, or 2. Add retry logic per-request.</p>
              <NotificationMarker category="needs-input" summary="Need decision on auth approach" />
            </div>
          </Card>
          <Card label="needs-input with suggested answers">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">The canary is healthy and ready for the next step.</p>
              <p className="text-cc-muted">Choose whether to continue the rollout now or hold for manual checks.</p>
              <PlaygroundSuggestedAnswerNotificationMarker />
            </div>
          </Card>
          <Card label="addressed needs-input with suggested answers">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">The rollout decision was answered.</p>
              <p className="text-cc-muted">No further reply is needed.</p>
              <PlaygroundAddressedSuggestedAnswerNotificationMarker />
            </div>
          </Card>
          <Card label="review (green, no summary)">
            <div className="text-cc-fg text-sm">
              <p>All changes have been committed and tests pass. The PR is ready for your review.</p>
              <PlaygroundReviewNotificationMarker />
            </div>
          </Card>
          <Card label="review with summary">
            <div className="text-cc-fg text-sm">
              <p>All changes have been committed and tests pass. The PR is ready for your review.</p>
              <PlaygroundReviewNotificationMarker summary="q-131: takode notify fixes ready" />
            </div>
          </Card>
          <Card label="deduped same-message authoritative + tool-use state">
            <PlaygroundDedupedNotificationMessage />
          </Card>
        </div>
      </Section>

      {/* ─── Work Board ──────────────────────────────────────────── */}
      <Section
        title="Work Board"
        description="Collapsible card rendered when a takode board command outputs board data. Shows quest/worker assignments and freeform status."
      >
        <div className="max-w-3xl space-y-4">
          <Card label="Board with items">
            <BoardBlock
              operation="advanced q-42 to IMPLEMENTING"
              queueWarnings={[
                {
                  questId: "q-61",
                  kind: "dispatchable",
                  summary: "q-61 can be dispatched now: wait-for resolved (q-50, #8).",
                  action: "Dispatch it now or replace QUEUED with the next active Quest Journey phase.",
                },
              ]}
              board={[
                {
                  questId: "q-42",
                  title: "Fix mobile sidebar overflow",
                  worker: "abc123",
                  workerNum: 5,
                  status: "IMPLEMENTING",
                  waitForInput: ["n-3", "n-4"],
                  updatedAt: Date.now() - 60000,
                },
                {
                  questId: "q-55",
                  title: "Add dark mode toggle",
                  worker: "def456",
                  workerNum: 8,
                  status: "QUEUED",
                  waitFor: ["#5"],
                  updatedAt: Date.now() - 30000,
                },
                {
                  questId: "q-61",
                  title: "Optimize DB queries",
                  status: "QUEUED",
                  waitFor: ["q-50", "#8"],
                  updatedAt: Date.now(),
                },
              ]}
            />
          </Card>
          <Card label="Board with raw debug control visible">
            <PlaygroundBoardWithOriginalCommand />
          </Card>
          <Card label="Optional Journey proposal">
            <BoardBlock
              operation="present q-942"
              proposalReview={{
                questId: "q-942",
                title: "Make proposed Journey drafting intentional",
                status: "PROPOSED",
                presentedAt: Date.now() - 30000,
                summary: "Proposed Journey with non-standard exploration",
                journey: {
                  mode: "proposed",
                  presetId: "proposal-flow",
                  phaseIds: ["alignment", "explore", "implement", "code-review"],
                  phaseNotes: {
                    "1": "Trace CLI, server, and UI paths before code.",
                  },
                  presentation: {
                    state: "presented",
                    presentedAt: Date.now() - 30000,
                    signature: "playground",
                  },
                },
              }}
              board={[
                {
                  questId: "q-942",
                  title: "Make proposed Journey drafting intentional",
                  status: "PROPOSED",
                  journey: {
                    mode: "proposed",
                    presetId: "proposal-flow",
                    phaseIds: ["alignment", "explore", "implement", "code-review"],
                  },
                  updatedAt: Date.now() - 30000,
                },
              ]}
            />
          </Card>
          <Card label="Empty board">
            <BoardBlock board={[]} />
          </Card>
        </div>
      </Section>

      {/* ─── Work Board Bar (Persistent Widget) ────────────────────── */}
      <Section
        title="Work Board Bar"
        description="Persistent top thread navigator for orchestrator sessions. Shows summary (collapsed) and full board table (expanded). Expanded/collapsed state persists per session in the browser, and composer interaction should not auto-collapse it."
      >
        <div className="max-w-3xl space-y-4">
          <Card label="Work Board Bar (click to seed store, then interact)">
            <div className="p-3 space-y-3">
              <button
                type="button"
                onClick={() => {
                  const boardSessionId = "playground-board-bar";
                  // Seed Zustand store with mock board and orchestrator session
                  const state = useStore.getState();
                  const now = Date.now();
                  const boardData: BoardRowData[] = [
                    {
                      questId: "q-42",
                      title: "Fix mobile sidebar overflow",
                      worker: "abc123",
                      workerNum: 5,
                      status: "IMPLEMENTING",
                      waitForInput: ["n-3"],
                      updatedAt: now - 60000,
                      journey: {
                        mode: "active" as const,
                        phaseIds: ["alignment", "implement", "execute", "code-review", "port"],
                        currentPhaseId: "implement",
                      },
                    },
                    {
                      questId: "q-55",
                      title: "Add dark mode toggle",
                      worker: "def456",
                      workerNum: 8,
                      status: "QUEUED",
                      waitFor: ["#5"],
                      updatedAt: now - 30000,
                      journey: {
                        mode: "proposed" as const,
                        phaseIds: ["alignment", "implement", "code-review", "port"],
                      },
                    },
                    {
                      questId: "q-61",
                      title: "Optimize DB queries",
                      status: "PROPOSED",
                      waitForInput: ["n-19"],
                      updatedAt: now,
                      journey: {
                        mode: "proposed" as const,
                        phaseIds: ["alignment", "explore", "implement", "execute", "port"],
                      },
                    },
                  ];
                  state.setSessionBoard(boardSessionId, boardData);
                  state.setSessionStatus(boardSessionId, "running");
                  state.setActiveTurnRoute(boardSessionId, { threadKey: "q-42", questId: "q-42" });
                  state.setSessionBoardRowStatuses(boardSessionId, {
                    "q-42": {
                      worker: {
                        sessionId: "playground-board-worker",
                        sessionNum: 5,
                        name: "Clear Mesa",
                        status: "running",
                      },
                      reviewer: {
                        sessionId: "playground-board-reviewer",
                        sessionNum: 6,
                        name: "Review Lead",
                        status: "idle",
                      },
                    },
                    "q-55": {
                      worker: {
                        sessionId: "playground-board-worker-queued",
                        sessionNum: 8,
                        name: "Queued Worker",
                        status: "idle",
                      },
                      reviewer: null,
                    },
                    "q-61": {
                      worker: {
                        sessionId: "playground-board-worker-proposed",
                        sessionNum: 9,
                        name: "Proposal Worker",
                        status: "disconnected",
                      },
                      reviewer: null,
                    },
                    "q-88": {
                      worker: {
                        sessionId: "playground-board-worker-done",
                        sessionNum: 10,
                        name: "Done Worker",
                        status: "archived",
                      },
                      reviewer: {
                        sessionId: "playground-board-reviewer-done",
                        sessionNum: 11,
                        name: "Done Reviewer",
                        status: "archived",
                      },
                    },
                  });
                  state.setSessionCompletedBoard(boardSessionId, [
                    {
                      questId: "q-88",
                      title: "Reviewed collapsed-result handling",
                      status: "DONE",
                      updatedAt: now - 120000,
                      completedAt: now - 110000,
                      journey: {
                        mode: "active" as const,
                        phaseIds: ["alignment", "implement", "execute", "code-review", "port"],
                        currentPhaseId: "port",
                      },
                    },
                  ]);
                  state.setSessionAttentionRecords(boardSessionId, [
                    {
                      id: "playground-board-bar-main-input",
                      leaderSessionId: boardSessionId,
                      type: "needs_input",
                      source: { kind: "notification", id: "playground-board-bar-main-input" },
                      threadKey: "main",
                      title: "Main needs input",
                      summary: "The leader has a Main-thread decision to make.",
                      actionLabel: "Answer",
                      priority: "needs_input",
                      state: "unresolved",
                      createdAt: now - 55_000,
                      updatedAt: now - 11_000,
                      route: { threadKey: "main" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-main-input",
                    },
                    {
                      id: "playground-board-bar-chip",
                      leaderSessionId: boardSessionId,
                      type: "needs_input",
                      source: { kind: "notification", id: "playground-board-bar-chip", questId: "q-42" },
                      questId: "q-42",
                      threadKey: "q-42",
                      title: "q-42 needs input",
                      summary: "The current worker has a question before continuing.",
                      actionLabel: "Answer",
                      priority: "needs_input",
                      state: "unresolved",
                      createdAt: now - 50_000,
                      updatedAt: now - 10_000,
                      route: { threadKey: "q-42", questId: "q-42" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-chip",
                    },
                    {
                      id: "playground-board-bar-rework",
                      leaderSessionId: boardSessionId,
                      type: "quest_reopened_or_rework",
                      source: { kind: "message", id: "playground-board-bar-rework", questId: "q-77" },
                      questId: "q-77",
                      threadKey: "q-77",
                      title: "q-77 rework requested",
                      summary: "The thread was reopened after user feedback.",
                      actionLabel: "Open",
                      priority: "milestone",
                      state: "reopened",
                      createdAt: now - 40_000,
                      updatedAt: now - 20_000,
                      route: { threadKey: "q-77", questId: "q-77" },
                      chipEligible: false,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-rework",
                    },
                    {
                      id: "playground-board-bar-closed-chip-input",
                      leaderSessionId: boardSessionId,
                      type: "needs_input",
                      source: { kind: "notification", id: "playground-board-bar-closed-chip-input", questId: "q-61" },
                      questId: "q-61",
                      threadKey: "q-61",
                      title: "q-61 needs input",
                      summary: "The queued thread is blocked on a decision.",
                      actionLabel: "Answer",
                      priority: "needs_input",
                      state: "unresolved",
                      createdAt: now - 25_000,
                      updatedAt: now - 12_000,
                      route: { threadKey: "q-61", questId: "q-61" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-closed-chip-input",
                    },
                    {
                      id: "playground-board-bar-review",
                      leaderSessionId: boardSessionId,
                      type: "review_ready",
                      source: { kind: "notification", id: "playground-board-bar-review", questId: "q-88" },
                      questId: "q-88",
                      threadKey: "q-88",
                      title: "Finished: review inbox copy",
                      summary: "",
                      actionLabel: "Review",
                      priority: "review",
                      state: "unresolved",
                      createdAt: now - 30_000,
                      updatedAt: now - 15_000,
                      route: { threadKey: "q-88", questId: "q-88" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-review",
                    },
                  ]);
                  const questIds = ["q-42", "q-55", "q-61", "q-77", "q-88", "q-99"];
                  const quests = state.quests
                    .filter((quest) => !questIds.includes(quest.questId))
                    .concat([
                      {
                        id: "q-42-v1",
                        questId: "q-42",
                        version: 1,
                        title: "Fix mobile sidebar overflow",
                        status: "in_progress" as const,
                        description: "Keep narrow mobile layouts from clipping the primary shell.",
                        createdAt: now - 4_800_000,
                        sessionId: "playground-board-worker",
                        claimedAt: now - 3_600_000,
                        leaderSessionId: boardSessionId,
                        tags: ["ui", "mobile", "journey"],
                      },
                      {
                        id: "q-55-v1",
                        questId: "q-55",
                        version: 1,
                        title: "Add dark mode toggle",
                        status: "refined" as const,
                        description: "Queued UI control work with proposed Journey metadata.",
                        createdAt: now - 3_900_000,
                        tags: ["ui"],
                      },
                      {
                        id: "q-61-v1",
                        questId: "q-61",
                        version: 1,
                        title: "Optimize DB queries",
                        status: "refined" as const,
                        description: "Proposal row used to exercise non-current Journey preview rendering.",
                        createdAt: now - 3_600_000,
                        tags: ["backend"],
                      },
                      {
                        id: "q-77-v1",
                        questId: "q-77",
                        version: 1,
                        title: "Off-board routed discussion",
                        status: "in_progress" as const,
                        description: "Off-board thread surfaced by attention, without active Journey metadata.",
                        createdAt: now - 3_000_000,
                        sessionId: "playground-board-worker",
                        claimedAt: now - 2_900_000,
                        tags: ["threads"],
                      },
                      {
                        id: "q-88-v2",
                        questId: "q-88",
                        version: 2,
                        title: "Reviewed collapsed-result handling",
                        status: "done" as const,
                        description: "Completed quest retained in history with Journey preview data.",
                        createdAt: now - 7_200_000,
                        completedAt: now - 110_000,
                        verificationItems: [],
                        tags: ["done", "journey"],
                      },
                      {
                        id: "q-99-v1",
                        questId: "q-99",
                        version: 1,
                        title: "Newly moved user request",
                        status: "in_progress" as const,
                        description: "Recently created quest tab used for insertion and hover preview checks.",
                        createdAt: now - 45_000,
                        sessionId: "playground-board-worker",
                        claimedAt: now - 30_000,
                        tags: ["threads"],
                      },
                    ]);
                  const playgroundSessionIds = [
                    boardSessionId,
                    "playground-board-worker",
                    "playground-board-reviewer",
                    "playground-board-worker-queued",
                    "playground-board-worker-proposed",
                    "playground-board-worker-done",
                    "playground-board-reviewer-done",
                  ];
                  const existing = state.sdkSessions.filter((s) => !playgroundSessionIds.includes(s.sessionId));
                  const sessionNames = new Map(state.sessionNames);
                  sessionNames.set("playground-board-worker", "Clear Mesa");
                  sessionNames.set("playground-board-reviewer", "Review Lead");
                  sessionNames.set("playground-board-worker-queued", "Queued Worker");
                  sessionNames.set("playground-board-worker-proposed", "Proposal Worker");
                  sessionNames.set("playground-board-worker-done", "Done Worker");
                  sessionNames.set("playground-board-reviewer-done", "Done Reviewer");
                  useStore.setState({
                    sdkSessions: [
                      ...existing,
                      {
                        sessionId: boardSessionId,
                        state: "connected",
                        cwd: "/mock/playground",
                        createdAt: now,
                        isOrchestrator: true,
                        sessionNum: 402,
                      },
                      {
                        sessionId: "playground-board-worker",
                        state: "running",
                        cwd: "/mock/playground",
                        createdAt: now - 3_600_000,
                        sessionNum: 5,
                        herdedBy: boardSessionId,
                      },
                      {
                        sessionId: "playground-board-reviewer",
                        state: "connected",
                        cwd: "/mock/playground",
                        createdAt: now - 2_400_000,
                        sessionNum: 6,
                      },
                      {
                        sessionId: "playground-board-worker-queued",
                        state: "connected",
                        cwd: "/mock/playground",
                        createdAt: now - 2_000_000,
                        sessionNum: 8,
                      },
                      {
                        sessionId: "playground-board-worker-proposed",
                        state: "exited",
                        cwd: "/mock/playground",
                        createdAt: now - 1_800_000,
                        sessionNum: 9,
                      },
                      {
                        sessionId: "playground-board-worker-done",
                        state: "exited",
                        cwd: "/mock/playground",
                        createdAt: now - 6_000_000,
                        sessionNum: 10,
                      },
                      {
                        sessionId: "playground-board-reviewer-done",
                        state: "exited",
                        cwd: "/mock/playground",
                        createdAt: now - 5_000_000,
                        sessionNum: 11,
                      },
                    ],
                    sessionNames,
                    quests,
                  });
                }}
                className="text-xs font-medium px-3 py-1.5 rounded-md bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 transition-colors cursor-pointer"
              >
                Seed board data
              </button>
              <button
                type="button"
                onClick={() => {
                  setBoardOpenThreadKeys((keys) => ["q-99", ...keys.filter((key) => key !== "q-99")]);
                  setBoardPreviewThreadKey("q-99");
                }}
                className="ml-2 text-xs font-medium px-3 py-1.5 rounded-md bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 transition-colors cursor-pointer"
              >
                Simulate moved-message tab
              </button>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => setBoardPreviewThreadKey("main")}
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                    boardPreviewThreadKey === "main"
                      ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
                      : "border-cc-border/70 bg-cc-hover/30 text-cc-muted hover:bg-cc-hover/60 hover:text-cc-fg"
                  }`}
                >
                  Main banner
                </button>
                <button
                  type="button"
                  onClick={() => setBoardPreviewThreadKey("q-42")}
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                    boardPreviewThreadKey === "q-42"
                      ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
                      : "border-cc-border/70 bg-cc-hover/30 text-cc-muted hover:bg-cc-hover/60 hover:text-cc-fg"
                  }`}
                >
                  Quest thread
                </button>
                <button
                  type="button"
                  onClick={() => setBoardPreviewThreadKey("all")}
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                    boardPreviewThreadKey === "all"
                      ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
                      : "border-cc-border/45 bg-transparent text-cc-muted hover:bg-cc-hover/45 hover:text-cc-fg"
                  }`}
                >
                  All Threads
                </button>
              </div>
              <div className="max-w-[28rem] border border-cc-border rounded-lg overflow-hidden">
                <WorkBoardBar
                  sessionId="playground-board-bar"
                  currentThreadKey={boardPreviewThreadKey}
                  currentThreadLabel={
                    boardPreviewThreadKey === "main"
                      ? "Main Thread"
                      : boardPreviewThreadKey === "all"
                        ? "All Threads"
                        : boardPreviewThreadKey
                  }
                  onSelectThread={setBoardPreviewThreadKey}
                  openThreadKeys={boardOpenThreadKeys}
                  onCloseThreadTab={(threadKey) =>
                    setBoardOpenThreadKeys((keys) => keys.filter((key) => key !== threadKey))
                  }
                  threadRows={[
                    {
                      threadKey: "q-99",
                      questId: "q-99",
                      title: "Newly moved user request",
                      messageCount: 1,
                      section: "active",
                    },
                    {
                      threadKey: "q-42",
                      questId: "q-42",
                      title: "Fix mobile sidebar overflow",
                      messageCount: 5,
                      section: "active",
                    },
                    {
                      threadKey: "q-55",
                      questId: "q-55",
                      title: "Add dark mode toggle",
                      messageCount: 3,
                      section: "active",
                    },
                    {
                      threadKey: "q-61",
                      questId: "q-61",
                      title: "Optimize DB queries",
                      messageCount: 2,
                      section: "active",
                    },
                    {
                      threadKey: "q-77",
                      questId: "q-77",
                      title: "Off-board routed discussion",
                      messageCount: 1,
                      section: "active",
                    },
                    {
                      threadKey: "q-88",
                      questId: "q-88",
                      title: "Reviewed collapsed-result handling",
                      messageCount: 2,
                      section: "done",
                    },
                  ]}
                  attentionRecords={[
                    {
                      id: "playground-board-bar-main-input",
                      leaderSessionId: "playground-board-bar",
                      type: "needs_input",
                      source: { kind: "notification", id: "playground-board-bar-main-input" },
                      threadKey: "main",
                      title: "Main needs input",
                      summary: "The leader has a Main-thread decision to make.",
                      actionLabel: "Answer",
                      priority: "needs_input",
                      state: "unresolved",
                      createdAt: Date.now() - 55_000,
                      updatedAt: Date.now() - 11_000,
                      route: { threadKey: "main" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-main-input",
                    },
                    {
                      id: "playground-board-bar-chip",
                      leaderSessionId: "playground-board-bar",
                      type: "needs_input",
                      source: { kind: "notification", id: "playground-board-bar-chip", questId: "q-42" },
                      questId: "q-42",
                      threadKey: "q-42",
                      title: "q-42 needs input",
                      summary: "The current worker has a question before continuing.",
                      actionLabel: "Answer",
                      priority: "needs_input",
                      state: "unresolved",
                      createdAt: Date.now() - 50_000,
                      updatedAt: Date.now() - 10_000,
                      route: { threadKey: "q-42", questId: "q-42" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-chip",
                    },
                    {
                      id: "playground-board-bar-rework",
                      leaderSessionId: "playground-board-bar",
                      type: "quest_reopened_or_rework",
                      source: { kind: "message", id: "playground-board-bar-rework", questId: "q-77" },
                      questId: "q-77",
                      threadKey: "q-77",
                      title: "q-77 rework requested",
                      summary: "The thread was reopened after user feedback.",
                      actionLabel: "Open",
                      priority: "milestone",
                      state: "reopened",
                      createdAt: Date.now() - 40_000,
                      updatedAt: Date.now() - 20_000,
                      route: { threadKey: "q-77", questId: "q-77" },
                      chipEligible: false,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-rework",
                    },
                    {
                      id: "playground-board-bar-closed-chip-input",
                      leaderSessionId: "playground-board-bar",
                      type: "needs_input",
                      source: { kind: "notification", id: "playground-board-bar-closed-chip-input", questId: "q-61" },
                      questId: "q-61",
                      threadKey: "q-61",
                      title: "q-61 needs input",
                      summary: "The queued thread is blocked on a decision.",
                      actionLabel: "Answer",
                      priority: "needs_input",
                      state: "unresolved",
                      createdAt: Date.now() - 25_000,
                      updatedAt: Date.now() - 12_000,
                      route: { threadKey: "q-61", questId: "q-61" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-closed-chip-input",
                    },
                    {
                      id: "playground-board-bar-review",
                      leaderSessionId: "playground-board-bar",
                      type: "review_ready",
                      source: { kind: "notification", id: "playground-board-bar-review", questId: "q-88" },
                      questId: "q-88",
                      threadKey: "q-88",
                      title: "Finished: review inbox copy",
                      summary: "",
                      actionLabel: "Review",
                      priority: "review",
                      state: "unresolved",
                      createdAt: Date.now() - 30_000,
                      updatedAt: Date.now() - 15_000,
                      route: { threadKey: "q-88", questId: "q-88" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-review",
                    },
                  ]}
                />
              </div>
              <p className="text-[10px] text-cc-muted">
                Click "Seed board data" first. Main keeps the tab rail anchored above the compact board banner and Open
                Workboard control; quest and All Threads selections keep the tab rail but hide the Work Board
                banner/table. The constrained width keeps several open tabs visible so their quest-id minimums,
                phase-colored titles, compact close affordances, horizontal overflow behavior, and newly inserted tab
                pop state can be inspected. Hover quest tabs to inspect the shared quest hover card with full Journey
                and participant context. The seeded active-output route targets q-42, so Main should not glow just
                because it is selected.
              </p>
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="Quest Status Panel"
        description="Compact quest/status summary used in thread-aware leader surfaces."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Card label="Selected session quest">
            <PlaygroundQuestStatusPanelDemo variant="claimed" />
          </Card>
          <Card label="Leader board attention row">
            <PlaygroundQuestStatusPanelDemo variant="board-attention" />
          </Card>
        </div>
      </Section>

      {/* ─── Timer Chip + Modal ──────────────────────────────────── */}
      <Section
        title="Timer Chip + Modal"
        description="Floating glassmorphic chip (like Purring indicator) that opens a modal with full timer details."
      >
        <div className="max-w-3xl space-y-4">
          <Card label="Timer chip (floating pill)">
            <div className="p-3 space-y-2">
              <button
                type="button"
                onClick={() => {
                  const now = Date.now();
                  useStore.setState({
                    sessionTimers: new Map([
                      [
                        "playground-timers",
                        [
                          {
                            id: "t1",
                            sessionId: "playground-timers",
                            title: "Check build status",
                            description: "inspect the latest build status and report back",
                            type: "delay" as const,
                            originalSpec: "30m",
                            nextFireAt: now + 1_800_000,
                            createdAt: now - 600_000,
                            fireCount: 0,
                          },
                          {
                            id: "t2",
                            sessionId: "playground-timers",
                            title: "Refresh context",
                            description: "re-read changed files and summarize what moved",
                            type: "recurring" as const,
                            originalSpec: "10m",
                            nextFireAt: now + 360_000,
                            intervalMs: 600_000,
                            createdAt: now - 1_200_000,
                            lastFiredAt: now - 600_000,
                            fireCount: 3,
                          },
                          {
                            id: "t3",
                            sessionId: "playground-timers",
                            title: "Deploy reminder",
                            description: "make sure the staging build passed CI before promoting to production",
                            type: "at" as const,
                            originalSpec: "3pm",
                            nextFireAt: now + 7_200_000,
                            createdAt: now - 300_000,
                            fireCount: 0,
                          },
                        ],
                      ],
                    ]),
                  });
                }}
                className="text-xs font-medium px-3 py-1.5 rounded-md bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 transition-colors cursor-pointer"
              >
                Seed timer data
              </button>
              {/* Dark container simulates the chat area where the chip floats */}
              <div className="relative h-24 rounded-lg border border-cc-border bg-cc-bg overflow-hidden">
                <div className="absolute bottom-2 right-2">
                  <TimerChip sessionId="playground-timers" />
                </div>
              </div>
              <p className="text-[10px] text-cc-muted">
                Click "Seed timer data" first. The chip shows timer count and next fire time as a glassmorphic pill.
                Click the chip to open the full modal with untruncated prompt text and cancel controls.
              </p>
            </div>
          </Card>

          <Card label="Timer modal (standalone)">
            <div className="p-3 space-y-2">
              <TimerModalDemo />
              <p className="text-[10px] text-cc-muted">
                Opens the timer detail modal. Seed timer data above first to see entries. Shows full prompt text, timer
                type, countdown, and per-timer cancel button.
              </p>
            </div>
          </Card>
        </div>
      </Section>

      {/* ─── Notification Inbox ──────────────────────────────────── */}
      <Section
        title="Notification Inbox"
        description="Per-session notification inbox for takode notify events. Chip + modal with active/done sections."
      >
        <div className="max-w-3xl space-y-4">
          <Card label="Notification chip (floating pill)">
            <div className="p-3 space-y-2">
              <button
                type="button"
                onClick={() => {
                  const now = Date.now();
                  useStore.setState({
                    sessionNotifications: new Map([
                      [
                        "playground-notifs",
                        [
                          {
                            id: "n-1",
                            category: "review" as const,
                            summary: "q-235 ready for review: Compact notification inbox copy",
                            timestamp: now - 600_000,
                            messageId: "mock-msg-42",
                            done: false,
                          },
                          {
                            id: "n-2",
                            category: "needs-input" as const,
                            summary: "Should we use JPEG q85 or q75 for the transport tier?",
                            suggestedAnswers: ["q85", "q75"],
                            timestamp: now - 120_000,
                            messageId: "mock-msg-87",
                            done: false,
                          },
                          {
                            id: "n-3",
                            category: "review" as const,
                            summary: "Port to main repo completed successfully",
                            timestamp: now - 3_600_000,
                            messageId: "mock-msg-15",
                            done: true,
                          },
                        ],
                      ],
                    ]),
                  });
                }}
                className="text-xs font-medium px-3 py-1.5 rounded-md bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 transition-colors cursor-pointer"
              >
                Seed notification data
              </button>
              <button
                type="button"
                onClick={() => {
                  const now = Date.now();
                  useStore.setState({
                    sessionNotifications: new Map([
                      [
                        "playground-notifs",
                        [
                          {
                            id: "stale-review",
                            category: "review" as const,
                            summary: "Older review cached locally",
                            timestamp: now - 300_000,
                            messageId: "mock-msg-stale",
                            done: false,
                          },
                        ],
                      ],
                    ]),
                  });
                  useStore.getState().setSdkSessions([
                    {
                      sessionId: "playground-notifs",
                      state: "connected",
                      cwd: "/playground",
                      createdAt: now,
                      archived: false,
                      notificationUrgency: "needs-input",
                      activeNotificationCount: 1,
                      notificationStatusVersion: 2,
                      notificationStatusUpdatedAt: now,
                    },
                  ]);
                }}
                className="ml-2 text-xs font-medium px-3 py-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer"
              >
                Seed summary-only needs-input
              </button>
              <div className="relative h-24 rounded-lg border border-cc-border bg-cc-bg overflow-hidden">
                <div className="absolute bottom-2 right-2">
                  <NotificationChip sessionId="playground-notifs" />
                </div>
              </div>
              <p className="text-[10px] text-cc-muted">
                Click &quot;Seed notification data&quot; first. Shows a compact single-height pill with inline
                comma-separated colored bell counts for active review and needs-input notifications, ending in
                &quot;unreads&quot;. Click to open the inbox modal with active notifications (amber = needs-input, green
                = review), compact quest-first review rows, and a collapsible Done section. On mobile, the modal
                stretches across the viewport while staying scrollable and height-capped.
              </p>
            </div>
          </Card>

          <Card label="Combined chips (same-line layout)">
            <div className="p-3 space-y-2">
              <p className="text-[10px] text-cc-muted mb-2">
                Seed both timer and notification data above, then see them side-by-side as they appear in the feed.
              </p>
              <div className="relative h-24 rounded-lg border border-cc-border bg-cc-bg overflow-hidden">
                <div className="pointer-events-none absolute bottom-2 right-2 flex flex-row items-end gap-1.5 sm:bottom-3 sm:right-3">
                  <TimerChip sessionId="playground-timers" />
                  <NotificationChip sessionId="playground-notifs" />
                </div>
              </div>
              <p className="text-[10px] text-cc-muted">
                Timer chip on the left, notification chip on the right -- mirrors FeedStatusPill layout.
              </p>
            </div>
          </Card>

          <Card label="Mobile nav clearance">
            <div className="p-3 space-y-2">
              <p className="text-[10px] text-cc-muted mb-2">
                On touch layouts, the feed navigation stack should keep all four controls visible, use larger touch
                targets, and float above the lower-right status chips instead of colliding with them.
              </p>
              <div className="relative h-32 rounded-lg border border-cc-border bg-cc-bg overflow-hidden">
                <div className="absolute right-2 flex flex-col gap-2" style={{ bottom: "42px" }}>
                  <button
                    type="button"
                    className="h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted"
                    aria-label="Playground go to top"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                      <path d="M4 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M4 12h8" strokeLinecap="round" />
                    </svg>
                  </button>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      className="h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted"
                      aria-label="Playground previous user message"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <path d="M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M8 3v10" strokeLinecap="round" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted"
                      aria-label="Playground next user message"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <path d="M4 9l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M8 3v10" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    className="h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted"
                    aria-label="Playground go to bottom"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                      <path d="M4 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M4 4h8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                <div className="pointer-events-none absolute bottom-2 right-2 flex flex-row items-end gap-1.5 sm:bottom-3 sm:right-3">
                  <TimerChip sessionId="playground-timers" />
                  <NotificationChip sessionId="playground-notifs" />
                </div>
              </div>
              <p className="text-[10px] text-cc-muted">
                The mock mirrors the touch feed: previous/next user-message buttons are restored, all four buttons use
                larger 40px targets with wider spacing, and the stack still reserves vertical clearance above the
                measured chip row on mobile.
              </p>
            </div>
          </Card>
        </div>
      </Section>

      {/* ─── Quest Detail Modal ──────────────────────────────────── */}
      <Section
        title="Quest Detail Modal"
        description="Global read-only quest detail overlay triggered from quest links in boards or markdown."
      >
        <div className="max-w-3xl space-y-4">
          <Card label="Open quest detail modal">
            <div className="p-3">
              <button
                type="button"
                onClick={() => {
                  // Seed store with mock quests then open the overlay
                  useStore.setState({
                    quests: [
                      {
                        id: "q-42-v3",
                        questId: "q-42",
                        version: 3,
                        title: "Fix mobile sidebar overflow on small screens",
                        status: "done" as const,
                        description:
                          "The sidebar overflows on screens narrower than 375px. Need to add `overflow-hidden` and a scrollable wrapper.\n\n## Steps\n1. Add wrapper div\n2. Set max-height\n3. Test on iPhone SE",
                        createdAt: Date.now() - 86400000,
                        updatedAt: Date.now() - 3600000,
                        previousOwnerSessionIds: ["abc-123"],
                        claimedAt: Date.now() - 43200000,
                        completedAt: Date.now() - 3600000,
                        tags: ["ui", "mobile", "bug"],
                        verificationItems: [
                          { text: "Sidebar does not overflow on iPhone SE", checked: true },
                          { text: "Scroll works on sidebar content", checked: false },
                          { text: "Desktop layout unaffected", checked: true },
                        ],
                        journeyRuns: [
                          {
                            runId: "playground-run-1",
                            source: "board" as const,
                            phaseIds: ["alignment", "implement", "code-review"],
                            status: "completed" as const,
                            createdAt: Date.now() - 7200000,
                            updatedAt: Date.now() - 3600000,
                            phaseOccurrences: [
                              {
                                occurrenceId: "playground-run-1:p1",
                                phaseId: "alignment" as const,
                                phaseIndex: 0,
                                phasePosition: 1,
                                phaseOccurrence: 1,
                                status: "completed" as const,
                              },
                              {
                                occurrenceId: "playground-run-1:p2",
                                phaseId: "implement" as const,
                                phaseIndex: 1,
                                phasePosition: 2,
                                phaseOccurrence: 1,
                                status: "completed" as const,
                              },
                              {
                                occurrenceId: "playground-run-1:p3",
                                phaseId: "code-review" as const,
                                phaseIndex: 2,
                                phasePosition: 3,
                                phaseOccurrence: 1,
                                status: "completed" as const,
                              },
                            ],
                          },
                        ],
                        feedback: [
                          {
                            author: "agent" as const,
                            kind: "phase_summary" as const,
                            text: "Implemented the responsive wrapper in [QuestDetailPanel.tsx:42](file:web/src/components/QuestDetailPanel.tsx:42) and verified that the sidebar content scrolls independently on narrow screens.",
                            tldr: "Implemented the narrow-screen wrapper in [QuestDetailPanel](web/src/components/QuestDetailPanel.tsx#L42).",
                            ts: Date.now() - 5400000,
                            authorSessionId: "abc-123",
                            journeyRunId: "playground-run-1",
                            phaseOccurrenceId: "playground-run-1:p2",
                            phaseId: "implement" as const,
                            phasePosition: 2,
                          },
                          {
                            author: "human" as const,
                            text: "Please also check iPad mini",
                            ts: Date.now() - 7200000,
                            addressed: true,
                          },
                          {
                            author: "agent" as const,
                            text: "Checked on iPad mini -- works correctly with the new wrapper.",
                            ts: Date.now() - 3600000,
                            authorSessionId: "abc-123",
                          },
                          {
                            author: "human" as const,
                            text: "Looks good! One more: the close button is hard to tap.",
                            ts: Date.now() - 1800000,
                            addressed: false,
                          },
                        ],
                      },
                    ],
                  });
                  useStore.getState().openQuestOverlay("q-42");
                }}
                className="px-4 py-2 text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white rounded-lg transition-colors cursor-pointer"
              >
                Open Quest Detail Modal (q-42)
              </button>
              <p className="text-xs text-cc-muted mt-2">
                Click to open a mock quest detail overlay. Press Escape or click the backdrop to close.
              </p>
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="Hover Cross-links"
        description="Quest and session markdown hovers cross-link through compact chips and preserve orchestration context inside the existing hover cards."
      >
        <div className="max-w-3xl space-y-4">
          <Card label="Quest hover shows orchestration">
            <PlaygroundHoverCrossLinkDemo text="Hover [q-418](quest:q-418) to see status, Journey, owner, and leader metadata in the quest hover preview." />
          </Card>
          <Card label="Session hover shows active quest">
            <PlaygroundHoverCrossLinkDemo text="Hover [#566](session:566) to see the worker's active quest chip in the session hover preview." />
          </Card>
          <Card label="Message link hover focuses the referenced message">
            <PlaygroundMessageLinkHoverDemo />
          </Card>
        </div>
      </Section>
    </PlaygroundSectionGroup>
  );
}
