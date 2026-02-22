#!/usr/bin/env bun
/**
 * Questmaster CLI — standalone tool for managing quests.
 *
 * Imports quest-store.ts directly (no HTTP for data operations).
 * After mutations, notifies the Companion server so browsers refresh.
 *
 * Usage:  quest <command> [options]
 *
 * Commands:
 *   list       List all quests (latest versions)
 *   show       Show full quest detail
 *   history    Show all versions of a quest
 *   create     Create a new quest
 *   claim      Claim a quest for a session
 *   complete   Transition to needs_verification with checklist
 *   done       Mark quest as done
 *   transition Generic status transition
 *   edit       In-place edit (no new version)
 *   check      Toggle a verification checkbox
 *   delete     Delete a quest and all versions
 */

import {
  listQuests,
  getQuest,
  getQuestHistory,
  createQuest,
  claimQuest,
  completeQuest,
  markDone,
  transitionQuest,
  patchQuest,
  checkVerificationItem,
  deleteQuest,
} from "../server/quest-store.js";
import type { QuestmasterTask } from "../server/quest-types.js";

// ─── Arg parsing helpers ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
}

/** Get positional arg at index (0-based, after the command). */
function positional(index: number): string | undefined {
  let pos = 0;
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // skip flag and its value if present
      if (args[i + 1] && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    if (pos === index) return args[i];
    pos++;
  }
  return undefined;
}

const jsonOutput = flag("json");

// ─── Server notification ────────────────────────────────────────────────────

async function notifyServer(): Promise<void> {
  const port = process.env.COMPANION_PORT;
  if (!port) return;
  try {
    await fetch(`http://localhost:${port}/api/quests/_notify`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Best effort — server may not be running
  }
}

// ─── Output helpers ─────────────────────────────────────────────────────────

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_ICONS: Record<string, string> = {
  idea: "○",
  refined: "●",
  in_progress: "◐",
  needs_verification: "◑",
  done: "✓",
};

const STATUS_LABELS: Record<string, string> = {
  idea: "idea",
  refined: "refined",
  in_progress: "in_progress",
  needs_verification: "verification",
  done: "done",
};

function formatQuestLine(q: QuestmasterTask): string {
  const cancelled = "cancelled" in q && (q as { cancelled?: boolean }).cancelled;
  const icon = cancelled ? "✗" : STATUS_ICONS[q.status] || "?";
  const tags = q.tags?.length ? `  [${q.tags.join(", ")}]` : "";
  const session =
    "sessionId" in q ? `  → session ${(q as { sessionId: string }).sessionId.slice(0, 8)}` : "";
  const statusLabel = cancelled ? "cancelled" : (STATUS_LABELS[q.status] ?? q.status);
  const pad = (s: string, len: number) => s.padEnd(len);
  return `${icon} ${pad(q.questId, 6)} ${pad(q.title, 36)}${tags}  (${statusLabel}${session})`;
}

function formatQuestDetail(q: QuestmasterTask): string {
  const lines: string[] = [];
  lines.push(`Quest ${q.questId} (v${q.version}, ${STATUS_LABELS[q.status] ?? q.status})`);
  lines.push(`Title:       ${q.title}`);
  if ("description" in q && q.description) {
    lines.push(`Description: ${q.description}`);
  }
  if (q.tags?.length) {
    lines.push(`Tags:        ${q.tags.join(", ")}`);
  }
  if ("sessionId" in q) {
    lines.push(`Session:     ${(q as { sessionId: string }).sessionId}`);
  }
  if ("claimedAt" in q) {
    lines.push(`Claimed:     ${timeAgo((q as { claimedAt: number }).claimedAt)}`);
  }
  if ("verificationItems" in q) {
    const items = (q as { verificationItems: { text: string; checked: boolean }[] })
      .verificationItems;
    const checked = items.filter((i) => i.checked).length;
    lines.push(`Verification: ${checked}/${items.length}`);
    for (let i = 0; i < items.length; i++) {
      lines.push(`  [${items[i].checked ? "x" : " "}] ${i}: ${items[i].text}`);
    }
  }
  if (q.images?.length) {
    lines.push(`Images:      ${q.images.length} attached`);
    for (const img of q.images) {
      lines.push(`  ${img.filename} → ${img.path}`);
    }
  }
  if ("cancelled" in q && (q as { cancelled?: boolean }).cancelled) {
    lines.push(`Cancelled:   yes`);
  }
  if ("notes" in q && (q as { notes?: string }).notes) {
    lines.push(`Notes:       ${(q as { notes: string }).notes}`);
  }
  if ("completedAt" in q) {
    lines.push(`Completed:   ${timeAgo((q as { completedAt: number }).completedAt)}`);
  }
  lines.push(`Created:     ${timeAgo(q.createdAt)}`);
  if (q.prevId) {
    lines.push(`Previous:    ${q.prevId}`);
  }
  return lines.join("\n");
}

function die(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  let quests = listQuests();
  const statusFilter = option("status");
  if (statusFilter) {
    quests = quests.filter((q) => q.status === statusFilter);
  }

  if (jsonOutput) {
    out(quests);
    return;
  }

  if (quests.length === 0) {
    console.log("No quests found.");
    return;
  }
  for (const q of quests) {
    console.log(formatQuestLine(q));
  }
}

async function cmdShow(): Promise<void> {
  const id = positional(0);
  if (!id) die("Usage: quest show <questId>");

  const quest = getQuest(id);
  if (!quest) die(`Quest ${id} not found`);

  if (jsonOutput) {
    out(quest);
    return;
  }
  console.log(formatQuestDetail(quest));
}

async function cmdHistory(): Promise<void> {
  const id = positional(0);
  if (!id) die("Usage: quest history <questId>");

  const versions = getQuestHistory(id);
  if (versions.length === 0) die(`Quest ${id} not found`);

  if (jsonOutput) {
    out(versions);
    return;
  }
  for (const v of versions) {
    console.log(`v${v.version} (${STATUS_LABELS[v.status] ?? v.status}) — ${timeAgo(v.createdAt)}  [${v.id}]`);
  }
}

async function cmdCreate(): Promise<void> {
  const title = positional(0);
  if (!title) die("Usage: quest create <title> [--desc \"...\"] [--tags \"t1,t2\"]");

  const description = option("desc");
  const tagsStr = option("tags");
  const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

  try {
    const quest = createQuest({ title, description, tags });
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Created ${quest.questId}: "${quest.title}" (${quest.status})`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdClaim(): Promise<void> {
  const id = positional(0);
  if (!id) die("Usage: quest claim <questId> [--session <sid>]");

  const sessionId = option("session") || process.env.COMPANION_SESSION_ID;
  if (!sessionId) die("No session ID. Pass --session <id> or set COMPANION_SESSION_ID.");

  try {
    const quest = claimQuest(id, sessionId);
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Claimed ${quest.questId} "${quest.title}" for session ${sessionId.slice(0, 8)}`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdComplete(): Promise<void> {
  const id = positional(0);
  if (!id) die("Usage: quest complete <questId> --items \"check1,check2\"");

  const itemsStr = option("items");
  if (!itemsStr) die("--items is required. Example: --items \"Tests pass,Typecheck passes\"");

  const items = itemsStr
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text) => ({ text, checked: false }));
  if (items.length === 0) die("--items must contain at least one non-empty item");

  try {
    const quest = completeQuest(id, items);
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Completed ${quest.questId} "${quest.title}" with ${items.length} verification items`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdDone(): Promise<void> {
  const id = positional(0);
  if (!id) die("Usage: quest done <questId> [--notes \"...\"] [--cancelled]");

  const notes = option("notes");
  const cancelled = flag("cancelled");

  try {
    const quest = markDone(id, { notes, cancelled });
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      const verb = cancelled ? "Cancelled" : "Marked done";
      console.log(`${verb} ${quest.questId} "${quest.title}"`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdTransition(): Promise<void> {
  const id = positional(0);
  if (!id) die("Usage: quest transition <questId> --status <s> [--desc \"...\"]");

  const status = option("status");
  if (!status) die("--status is required");

  const description = option("desc");
  const sessionId = option("session") || process.env.COMPANION_SESSION_ID;

  try {
    const quest = transitionQuest(id, {
      status: status as import("../server/quest-types.js").QuestStatus,
      ...(description !== undefined ? { description } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Transitioned ${quest.questId} to ${quest.status}`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdEdit(): Promise<void> {
  const id = positional(0);
  if (!id) die("Usage: quest edit <questId> [--title \"...\"] [--desc \"...\"] [--tags \"t1,t2\"]");

  const title = option("title");
  const description = option("desc");
  const tagsStr = option("tags");
  const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

  if (title === undefined && description === undefined && tags === undefined) {
    die("At least one of --title, --desc, or --tags is required");
  }

  try {
    const quest = patchQuest(id, {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Updated ${quest.questId} "${quest.title}"`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdCheck(): Promise<void> {
  const id = positional(0);
  const indexStr = positional(1);
  if (!id || indexStr === undefined) die("Usage: quest check <questId> <index>");

  const index = Number(indexStr);
  if (Number.isNaN(index)) die("Index must be a number");

  // Toggle: read current state and flip it
  const current = getQuest(id);
  if (!current) die(`Quest ${id} not found`);
  if (!("verificationItems" in current)) die("Quest has no verification items");
  const items = (current as { verificationItems: { checked: boolean }[] }).verificationItems;
  if (index < 0 || index >= items.length) die(`Index ${index} out of range (0-${items.length - 1})`);
  const newChecked = !items[index].checked;

  try {
    const quest = checkVerificationItem(id, index, newChecked);
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      const item = (quest as { verificationItems: { text: string; checked: boolean }[] })
        .verificationItems[index];
      console.log(`[${item.checked ? "x" : " "}] ${item.text}`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdDelete(): Promise<void> {
  const id = positional(0);
  if (!id) die("Usage: quest delete <questId>");

  const deleted = deleteQuest(id);
  if (!deleted) die(`Quest ${id} not found`);
  await notifyServer();
  if (jsonOutput) {
    out({ deleted: true, questId: id });
  } else {
    console.log(`Deleted ${id} and all versions`);
  }
}

async function cmdTags(): Promise<void> {
  const quests = listQuests();
  const tagCounts = new Map<string, number>();
  for (const q of quests) {
    if (q.tags) {
      for (const tag of q.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }

  if (jsonOutput) {
    out(Object.fromEntries(tagCounts));
    return;
  }

  if (tagCounts.size === 0) {
    console.log("No tags found.");
    return;
  }
  // Sort by count desc, then alpha
  const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [tag, count] of sorted) {
    console.log(`  ${tag} (${count})`);
  }
}

// ─── Help ───────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`Questmaster CLI

Usage: quest <command> [options]

Commands:
  list   [--status <s>] [--json]                         List quests
  show   <id> [--json]                                   Show quest detail
  history <id> [--json]                                  Show version history
  tags   [--json]                                        List all existing tags with counts
  create <title> [--desc "..."] [--tags "t1,t2"] [--json] Create a quest
  claim  <id> [--session <sid>] [--json]                 Claim for session
  complete <id> --items "c1,c2" [--json]                 Submit for verification
  done   <id> [--notes "..."] [--cancelled] [--json]      Mark as done/cancelled
  transition <id> --status <s> [--desc "..."] [--json]   Change status
  edit   <id> [--title "..."] [--desc "..."] [--json]    Edit in place
  check  <id> <index> [--json]                           Toggle verification item
  delete <id> [--json]                                   Delete quest

Environment:
  COMPANION_SESSION_ID  Session ID (auto-set by Companion)
  COMPANION_PORT        Server port for browser notifications`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  switch (command) {
    case "list":
      return cmdList();
    case "show":
      return cmdShow();
    case "history":
      return cmdHistory();
    case "tags":
      return cmdTags();
    case "create":
      return cmdCreate();
    case "claim":
      return cmdClaim();
    case "complete":
      return cmdComplete();
    case "done":
      return cmdDone();
    case "transition":
      return cmdTransition();
    case "edit":
      return cmdEdit();
    case "check":
      return cmdCheck();
    case "delete":
      return cmdDelete();
    case "help":
    case "--help":
    case "-h":
    case undefined:
      showHelp();
      return;
    default:
      die(`Unknown command: ${command}. Run 'quest help' for usage.`);
  }
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
