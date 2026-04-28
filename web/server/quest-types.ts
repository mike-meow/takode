// ─── Questmaster Types ───────────────────────────────────────────────────────
//
// Progressive types: each stage extends the previous, strictly adding fields
// where practical.
//
// Legacy quest storage persisted a full version chain on disk (`q-1-v1.json`,
// `q-1-v2.json`, ...). The newer live store keeps only one mutable current
// record per quest on the hot path, but it preserves the latest revision-shaped
// `id`/`version` fields for compatibility with existing UI and CLI code.
//
// ─── Quest ownership model ───────────────────────────────────────────────────
//
// A session can own any number of quests across all statuses, but at most ONE
// quest may be `in_progress` per session at a time. This invariant is enforced
// by claimQuest() in quest-store.ts — attempting to claim a second quest while
// one is already in_progress throws an error. The rationale:
//
//   - The UI and auto-namer show the active quest's metadata (title, ID).
//     Multiple concurrent in_progress quests would create ambiguity about
//     which one to display.
//   - getActiveQuestForSession(sessionId) returns the single in_progress quest
//     for a session, or null. It's used by the auto-namer to include quest
//     context in naming prompts.
//   - Quests in other states (done, refined, idea) are
//     unaffected — a session can have any number of those.

export type QuestStatus = "idea" | "refined" | "in_progress" | "done";
export type LegacyQuestStatus = QuestStatus | "needs_verification";

export interface QuestVerificationItem {
  text: string;
  checked: boolean;
}

/** A single entry in the quest feedback thread (PR-review style). */
export interface QuestFeedbackEntry {
  author: "human" | "agent";
  text: string;
  /** Human-readable scan summary for long feedback/comment text. */
  tldr?: string;
  ts: number;
  /** Companion session ID that authored this entry (for agent comments). */
  authorSessionId?: string;
  /** Images attached to this feedback entry */
  images?: QuestImage[];
  /** Whether this feedback has been addressed (only meaningful for human entries) */
  addressed?: boolean;
}

/** An image attached to a quest, stored on disk. */
export interface QuestImage {
  /** Unique image ID (used for filename) */
  id: string;
  /** Original filename from upload */
  filename: string;
  /** MIME type (image/png, image/jpeg, etc.) */
  mimeType: string;
  /** Absolute path on disk (~/.companion/questmaster/images/<id>.<ext>) */
  path: string;
}

// ─── Base fields shared by all stages ────────────────────────────────────────

interface QuestBase {
  /** Opaque current-record identifier. Legacy backups use ids like "q-1-v3". */
  id: string;
  /** Stable across versions: "q-1" */
  questId: string;
  /** Monotonic live revision counter for the current quest record. */
  version: number;
  /** Legacy-only backlink used when reading version-history backups. */
  prevId?: string;
  title: string;
  /** Human-readable scan summary for long quest descriptions. */
  tldr?: string;
  /** When the quest was originally created. */
  createdAt: number;
  /** Last in-place modification (checkbox toggle, patch, image change).
   *  Only set by in-place mutations; absent on freshly created versions. */
  updatedAt?: number;
  /** Last status transition time. Preserves Questmaster recency ordering. */
  statusChangedAt?: number;
  tags?: string[];
  /** Stable questId of parent task (for subtasks) */
  parentId?: string;
  /** Attached images stored on disk */
  images?: QuestImage[];
  /** Past owners in chronological order. Excludes the current active owner. */
  previousOwnerSessionIds?: string[];
  /** Ordered synced commit SHAs associated with this quest's verification handoff. */
  commitShas?: string[];
  /** Threaded feedback conversation that must survive quest version transitions. */
  feedback?: QuestFeedbackEntry[];
}

// ─── Progressive stage types (each extends the previous) ─────────────────────

/** Idea: raw thought, description optional */
export type QuestIdea = QuestBase & {
  status: "idea";
  description?: string;
};

/** Refined: fleshed out, description required */
export type QuestRefined = QuestBase & {
  status: "refined";
  description: string;
};

/** In Progress: claimed by a session */
export type QuestInProgress = Omit<QuestRefined, "status"> & {
  status: "in_progress";
  /** Active owner session ID (historically named sessionId for compatibility). */
  sessionId: string;
  claimedAt: number;
};

/** Done: completed, optionally awaiting human review through separate metadata. */
export type QuestDone = Omit<QuestInProgress, "status" | "sessionId" | "claimedAt"> & {
  status: "done";
  /** Active owner is cleared when done; sessionId may be present in legacy data. */
  sessionId?: string;
  /** Preserved for compatibility/history display when available. */
  claimedAt?: number;
  completedAt: number;
  verificationItems: QuestVerificationItem[];
  /**
   * Present only while a completed quest is still in the review workflow.
   * true means fresh review inbox; false means acknowledged/under review.
   * Undefined means final done, not in review surfaces.
   */
  verificationInboxUnread?: boolean;
  /** Free-form closure notes (commit hashes, reasoning, references, etc.) */
  notes?: string;
  /** If true, this quest was cancelled/aborted rather than completed */
  cancelled?: boolean;
};

// ─── Union type ──────────────────────────────────────────────────────────────

export type QuestmasterTask = QuestIdea | QuestRefined | QuestInProgress | QuestDone;

export function hasQuestReviewMetadata(quest: QuestmasterTask | null | undefined): quest is QuestDone {
  return quest?.status === "done" && quest.cancelled !== true && typeof quest.verificationInboxUnread === "boolean";
}

export function isQuestReviewInboxUnread(quest: QuestmasterTask | null | undefined): boolean {
  return hasQuestReviewMetadata(quest) && quest.verificationInboxUnread === true;
}

export type QuestHistoryMode = "live" | "legacy_backup" | "unavailable";

export interface QuestHistoryView {
  mode: QuestHistoryMode;
  entries: QuestmasterTask[];
  message?: string;
  backupDir?: string;
}

export interface QuestMigrationUnreadableFile {
  file: string;
  questId: string;
  error: string;
}

export interface QuestMigrationBlockedQuest {
  questId: string;
  files: string[];
  errors: string[];
}

export type QuestMigrationSnapshotStatus = "readable" | "missing" | "unreadable";

export interface QuestStoreMigrationReport {
  legacyQuestCount: number;
  migratedQuestCount: number;
  snapshotQuestCount: number;
  snapshotStatus: QuestMigrationSnapshotStatus;
  snapshotError?: string;
  snapshotMismatchQuestIds: string[];
  unreadableFiles: QuestMigrationUnreadableFile[];
  blockedQuests: QuestMigrationBlockedQuest[];
}

// ─── Input types (for APIs) ──────────────────────────────────────────────────

export interface QuestCreateInput {
  title: string;
  description?: string;
  tldr?: string;
  status?: QuestStatus;
  tags?: string[];
  parentId?: string;
  /** Pre-saved images to attach on creation */
  images?: QuestImage[];
}

/** Same-stage edits (e.g., fixing a typo). Does NOT create a new version. */
export interface QuestPatchInput {
  title?: string;
  description?: string;
  tldr?: string;
  tags?: string[];
  /** Replace the feedback thread (used by the append endpoint after adding an entry) */
  feedback?: QuestFeedbackEntry[];
}

/** Status transitions. Always creates a new version linked to the previous. */
export interface QuestTransitionInput {
  status: QuestStatus;
  /** Required for refined+ */
  description?: string;
  /** Human-readable scan summary for long descriptions. */
  tldr?: string;
  /** Required for in_progress+ */
  sessionId?: string;
  /** Human-review checklist. Accepts strings (normalized to {text, checked:false}) or full objects. */
  verificationItems?: (QuestVerificationItem | string)[];
  /** Ordered synced commit SHAs to attach at verification handoff. */
  commitShas?: string[];
  /** Review inbox state for done quests that are awaiting/under human review. */
  verificationInboxUnread?: boolean;
  /** Closure notes for done status (commit hashes, reasoning, etc.) */
  notes?: string;
  /** If true, marks this as cancelled/aborted rather than completed */
  cancelled?: boolean;
}
