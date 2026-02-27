// ─── Questmaster Types ───────────────────────────────────────────────────────
//
// Progressive types: each stage extends the previous, strictly adding fields
// where practical.
// Linked-list versioning: every status transition creates a new version object
// linked to the previous. No data is ever lost.
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
//   - Quests in other states (done, needs_verification, refined, idea) are
//     unaffected — a session can have any number of those.

export type QuestStatus = "idea" | "refined" | "in_progress" | "needs_verification" | "done";

export interface QuestVerificationItem {
  text: string;
  checked: boolean;
}

/** A single entry in the quest feedback thread (PR-review style). */
export interface QuestFeedbackEntry {
  author: "human" | "agent";
  text: string;
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
  /** Unique per version: "q-1-v3" */
  id: string;
  /** Stable across versions: "q-1" */
  questId: string;
  /** Monotonically increasing: 1, 2, 3... */
  version: number;
  /** Links to previous version: "q-1-v2" */
  prevId?: string;
  title: string;
  /** When this version was created (stable — never mutated after creation) */
  createdAt: number;
  /** Last in-place modification (checkbox toggle, patch, image change).
   *  Only set by in-place mutations; absent on freshly created versions. */
  updatedAt?: number;
  tags?: string[];
  /** Stable questId of parent task (for subtasks) */
  parentId?: string;
  /** Attached images stored on disk */
  images?: QuestImage[];
  /** Past owners in chronological order. Excludes the current active owner. */
  previousOwnerSessionIds?: string[];
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

/** Needs Verification: agent done, human checks required */
export type QuestNeedsVerification = Omit<QuestInProgress, "status"> & {
  status: "needs_verification";
  verificationItems: QuestVerificationItem[];
  /** True when this verification quest is in the review inbox and needs a fresh human read. */
  verificationInboxUnread?: boolean;
  /** Threaded feedback conversation between human reviewer and agent */
  feedback?: QuestFeedbackEntry[];
};

/** Done: all verification complete (or cancelled) */
export type QuestDone = Omit<QuestNeedsVerification, "status" | "sessionId" | "claimedAt"> & {
  status: "done";
  /** Active owner is cleared when done; sessionId may be present in legacy data. */
  sessionId?: string;
  /** Preserved for compatibility/history display when available. */
  claimedAt?: number;
  completedAt: number;
  /** Free-form closure notes (commit hashes, reasoning, references, etc.) */
  notes?: string;
  /** If true, this quest was cancelled/aborted rather than completed */
  cancelled?: boolean;
};

// ─── Union type ──────────────────────────────────────────────────────────────

export type QuestmasterTask =
  | QuestIdea
  | QuestRefined
  | QuestInProgress
  | QuestNeedsVerification
  | QuestDone;

// ─── Input types (for APIs) ──────────────────────────────────────────────────

export interface QuestCreateInput {
  title: string;
  description?: string;
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
  tags?: string[];
  /** Replace the feedback thread (used by the append endpoint after adding an entry) */
  feedback?: QuestFeedbackEntry[];
}

/** Status transitions. Always creates a new version linked to the previous. */
export interface QuestTransitionInput {
  status: QuestStatus;
  /** Required for refined+ */
  description?: string;
  /** Required for in_progress+ */
  sessionId?: string;
  /** Required for needs_verification+. Accepts strings (normalized to {text, checked:false}) or full objects. */
  verificationItems?: (QuestVerificationItem | string)[];
  /** Closure notes for done status (commit hashes, reasoning, etc.) */
  notes?: string;
  /** If true, marks this as cancelled/aborted rather than completed */
  cancelled?: boolean;
}
