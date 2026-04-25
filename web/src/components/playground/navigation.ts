export type PlaygroundSectionGroupId = "overview" | "interactive" | "states";

export interface PlaygroundNavItem {
  id: string;
  title: string;
}

export interface PlaygroundNavGroup {
  id: PlaygroundSectionGroupId;
  title: string;
  description: string;
  items: PlaygroundNavItem[];
}

function slugifyPlaygroundTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

export function getPlaygroundSectionId(groupId: PlaygroundSectionGroupId, title: string): string {
  return `${groupId}-${slugifyPlaygroundTitle(title)}`;
}

function createNavGroup(
  id: PlaygroundSectionGroupId,
  title: string,
  description: string,
  itemTitles: string[],
): PlaygroundNavGroup {
  return {
    id,
    title,
    description,
    items: itemTitles.map((itemTitle) => ({
      id: getPlaygroundSectionId(id, itemTitle),
      title: itemTitle,
    })),
  };
}

export const PLAYGROUND_NAV_GROUPS: PlaygroundNavGroup[] = [
  createNavGroup("overview", "Overview", "Core display surfaces and reference states.", [
    "Permission Banners",
    "Collapsed Permissions Chip",
    "Auto-Approval Evaluating",
    "Real Chat Stack",
    "Search Preview Chat",
    "Shortcut Hints",
    "Floating Feed Status",
    "MessageFeed Section Windowing",
    "Conversation Loading State",
    "Codex Terminal Chips",
    "Codex Pending Inputs",
    "Codex Image Send States",
    "ChatView Recovery States",
    "PlanReviewOverlay",
    "PlanCollapsedChip",
    "AskUserQuestion",
    "Messages",
    "Copy Features",
    "Image Lightbox",
    "Markdown Tables",
    "Tool Blocks",
    "Tool Block Error Boundary",
    "Tool Progress",
    "Tool Use Summary",
    "Tasks",
    "GitHub PR Status",
    "MCP Servers",
    "Codex Session Details",
    "Status Indicators",
    "Session List Herd Groups",
    "Herd Collapsible Container",
    "Quest Title Styling",
  ]),
  createNavGroup("interactive", "Interactive", "Controls, overlays, and jumpable workflows.", [
    "Composer",
    "Reply Chip",
    "Selection Context Menu",
    "User Message Reply Chip",
    "Notification Marker",
    "Work Board",
    "Work Board Bar",
    "Timer Chip + Modal",
    "Notification Inbox",
    "Quest Detail Modal",
    "Hover Cross-links",
  ]),
  createNavGroup("states", "States", "Streaming, grouped activity, and state-heavy component demos.", [
    "Composer — Voice Recording",
    "Streaming Indicator",
    "Tool Message Groups",
    "Subagent Groups",
    "Collapsed Activity Bars",
    "Herd Event Chips",
    "Timer Messages",
    "Diff Viewer",
    "Session Creation Progress",
    "Session Creation View",
    "CLAUDE.md Editor",
    "Cat Theme Elements",
    "Session Search",
    "Folder Picker",
  ]),
];

export const PLAYGROUND_NAV_ITEMS = PLAYGROUND_NAV_GROUPS.flatMap((group) => group.items);
export const PLAYGROUND_NAV_ITEM_IDS = new Set(PLAYGROUND_NAV_ITEMS.map((item) => item.id));
export const DEFAULT_PLAYGROUND_SECTION_ID = PLAYGROUND_NAV_GROUPS[0]?.items[0]?.id ?? "overview-permission-banners";
