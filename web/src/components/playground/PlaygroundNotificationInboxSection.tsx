import { NotificationChip } from "../NotificationChip.js";
import { GlobalNeedsInputMenu } from "../GlobalNeedsInputMenu.js";
import { TimerChip } from "../TimerWidget.js";
import { useStore } from "../../store.js";
import { Card, Section } from "./shared.js";

function seedNotificationData() {
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
            summary: "Choose image transport and validation path",
            questions: [
              {
                prompt: "Should we use JPEG q85 or q75 for the transport tier?",
                suggestedAnswers: ["q85", "q75"],
              },
              {
                prompt: "Run browser validation in Execute?",
                suggestedAnswers: ["yes", "no"],
              },
              {
                prompt:
                  "Add any reviewer context or rollout caveats that should travel with this answer. This is intentionally long enough to exercise the auto-expanding custom answer field.",
              },
            ],
            timestamp: now - 120_000,
            messageId: "mock-msg-87",
            done: false,
          },
          {
            id: "n-3",
            category: "waiting" as const,
            summary: "Waiting on reviewer handoff",
            timestamp: now - 300_000,
            messageId: "mock-msg-31",
            done: false,
          },
          {
            id: "n-4",
            category: "review" as const,
            summary: "Port to main repo completed successfully",
            timestamp: now - 3_600_000,
            messageId: "mock-msg-15",
            done: true,
          },
        ],
      ],
    ]),
    messages: new Map([
      [
        "playground-notifs",
        [
          {
            id: "mock-msg-87",
            role: "assistant" as const,
            content:
              "The image transport choice affects mobile screenshot upload size and how much artifact detail reviewers can inspect. JPEG q85 keeps edges readable; q75 is smaller but can blur dense UI text.",
            timestamp: now - 130_000,
          },
        ],
      ],
    ]),
  });
}

function seedSummaryOnlyNeedsInput() {
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
}

function seedGlobalNeedsInputData() {
  const now = Date.now();
  useStore.setState({
    sessionNotifications: new Map([
      [
        "global-needs-input-leader",
        [
          {
            id: "global-n-1",
            category: "needs-input" as const,
            summary: "Choose the worker handoff path",
            suggestedAnswers: ["dispatch now", "wait for review"],
            timestamp: now - 90_000,
            messageId: "global-msg-1",
            done: false,
          },
        ],
      ],
      [
        "global-needs-input-worker",
        [
          {
            id: "global-n-2",
            category: "needs-input" as const,
            summary: "Confirm validation coverage",
            questions: [
              { prompt: "Run browser validation?", suggestedAnswers: ["yes", "no"] },
              { prompt: "Include mobile viewport?", suggestedAnswers: ["yes", "desktop only"] },
            ],
            timestamp: now - 30_000,
            messageId: "global-msg-2",
            done: false,
          },
          {
            id: "global-review",
            category: "review" as const,
            summary: "Review-only item excluded from global needs-input",
            timestamp: now - 15_000,
            messageId: "global-msg-review",
            done: false,
          },
        ],
      ],
    ]),
    messages: new Map([
      [
        "global-needs-input-leader",
        [
          {
            id: "global-msg-1",
            role: "assistant" as const,
            content:
              "The worker can start now if the reviewer only needs a scope pass. Waiting preserves reviewer bandwidth but delays the current handoff.",
            timestamp: now - 100_000,
          },
        ],
      ],
      [
        "global-needs-input-worker",
        [
          {
            id: "global-msg-2",
            role: "assistant" as const,
            content:
              "Validation coverage should include the desktop operator view plus the mobile approval path, because the notification panel sits close to feed controls on narrow screens.",
            timestamp: now - 45_000,
          },
        ],
      ],
    ]),
  });
  useStore.getState().setSdkSessions([
    {
      sessionId: "global-needs-input-leader",
      state: "connected",
      cwd: "/playground",
      createdAt: now,
      sessionNum: 401,
      name: "Leader",
    },
    {
      sessionId: "global-needs-input-worker",
      state: "connected",
      cwd: "/playground",
      createdAt: now,
      sessionNum: 402,
      name: "Worker",
    },
  ]);
}

export function PlaygroundNotificationInboxSection() {
  return (
    <Section
      title="Notification Inbox"
      description="Per-session notification inbox for takode notify events. Chip + modal with active/done sections."
    >
      <div className="max-w-3xl space-y-4">
        <Card label="Notification chip (floating pill)">
          <div className="p-3 space-y-2">
            <button
              type="button"
              onClick={seedNotificationData}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-cc-info-border bg-cc-info-bg hover:bg-cc-info-bg/80 text-cc-info transition-colors cursor-pointer"
            >
              Seed notification data
            </button>
            <button
              type="button"
              onClick={seedSummaryOnlyNeedsInput}
              className="ml-2 text-xs font-medium px-3 py-1.5 rounded-md border border-cc-attention-border bg-cc-attention-bg hover:bg-cc-attention-bg/80 text-cc-attention transition-colors cursor-pointer"
            >
              Seed summary-only needs-input
            </button>
            <div className="relative h-24 rounded-lg border border-cc-border bg-cc-bg overflow-hidden">
              <div className="absolute bottom-2 right-2">
                <NotificationChip sessionId="playground-notifs" />
              </div>
            </div>
            <p className="text-[10px] text-cc-muted">
              Click &quot;Seed notification data&quot; first. The inbox shows needs-input rows with one prompt title,
              expandable source context, direct Send Response controls, voice-enabled long-answer fields, compact
              quest-first review rows, and a collapsible Done section. On mobile, the modal stretches across the
              viewport while staying scrollable and height-capped.
            </p>
          </div>
        </Card>

        <Card label="Global top-bar needs-input aggregate">
          <div className="p-3 space-y-2">
            <button
              type="button"
              onClick={seedGlobalNeedsInputData}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-cc-attention-border bg-cc-attention-bg hover:bg-cc-attention-bg/80 text-cc-attention transition-colors cursor-pointer"
            >
              Seed global needs-input data
            </button>
            <div className="flex h-16 items-start justify-end rounded-lg border border-cc-border bg-cc-bg p-3">
              <GlobalNeedsInputMenu />
            </div>
            <p className="text-[10px] text-cc-muted">
              Shows the top-bar aggregate for unresolved needs-input notifications, with quiet source-context navigation
              and review or unread-style activity excluded.
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
              larger 40px targets with wider spacing, and the stack still reserves vertical clearance above the measured
              chip row on mobile.
            </p>
          </div>
        </Card>
      </div>
    </Section>
  );
}
