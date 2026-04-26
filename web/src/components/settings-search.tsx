import { useEffect, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { sessionSearchTextMatches } from "../store-session-search.js";

type SettingItemMeta = {
  id: string;
  text: string;
  aliases?: string[];
};

export type SettingsSectionId =
  | "appearance"
  | "notifications"
  | "shortcuts"
  | "cli"
  | "sessions"
  | "pushover"
  | "auto-approval"
  | "session-namer"
  | "voice-transcription"
  | "server";

export type SettingsSectionMeta = {
  id: SettingsSectionId;
  title: string;
  description?: string;
  aliases?: string[];
  items: SettingItemMeta[];
};

export type SettingsSearchResults = {
  query: string;
  hasQuery: boolean;
  totalMatches: number;
  visibleSectionIds: Set<SettingsSectionId>;
  sectionMatchCounts: Map<SettingsSectionId, number>;
  visibleItemIds: Map<SettingsSectionId, Set<string>>;
};

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: "appearance",
    title: "Appearance & Display",
    aliases: ["theme", "dark", "light", "zoom", "display", "usage", "sidebar", "diff", "edit", "write"],
    items: [
      { id: "theme", text: "Theme color theme dark light appearance" },
      { id: "zoom", text: "Zoom display scale text size" },
      { id: "usage-bars", text: "Usage Bars in Sidebar tokens sidebar usage" },
      { id: "edit-blocks", text: "Expand Edit/Write Blocks diffs tool blocks" },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    aliases: ["alerts", "desktop", "sound", "permission"],
    items: [
      { id: "sound", text: "Sound notification audio alerts" },
      { id: "desktop-alerts", text: "Desktop Alerts browser notifications permission" },
    ],
  },
  {
    id: "shortcuts",
    title: "Shortcuts",
    description:
      "Keyboard shortcuts stay off by default. Choose a preset, then optionally override individual actions.",
    aliases: ["keyboard", "keys", "hotkeys", "vim", "vscode"],
    items: [
      { id: "enabled", text: "Enabled keyboard shortcuts hotkeys" },
      { id: "preset", text: "Preset standard vscode vim shortcut preset", aliases: ["vscode"] },
      { id: "bindings", text: "Record shortcut override actions reset bindings" },
    ],
  },
  {
    id: "cli",
    title: "CLI & Backends",
    description:
      "Custom path or command for backend CLIs. Leave empty to auto-detect from PATH. New sessions use this immediately; existing sessions pick it up on relaunch.",
    aliases: ["backend", "claude", "codex", "binary", "path", "editor", "vscode", "cursor", "logs", "environment"],
    items: [
      { id: "claude", text: "Claude Code binary path command auto-detect" },
      { id: "codex", text: "Codex binary path command auto-detect" },
      {
        id: "codex-leader-context-window",
        text: "Codex leader context window override orchestration recycle compaction tokens 1M",
      },
      {
        id: "codex-leader-recycle-threshold",
        text: "Codex leader recycle threshold orchestration compaction tokens 260k",
      },
      { id: "default-backend", text: "Default Backend Claude CLI Claude SDK backend" },
      { id: "log-file", text: "Log File server runtime logs" },
      { id: "editor", text: "File Link Editor VSCode local remote Cursor none editor", aliases: ["vscode"] },
      { id: "environments", text: "Manage Environments environment defaults" },
    ],
  },
  {
    id: "sessions",
    title: "Sessions",
    aliases: ["keep alive", "worktree", "heavy repo", "sleep", "caffeinate", "import", "export"],
    items: [
      { id: "max-keep-alive", text: "Max Keep-Alive live CLI processes idle sessions" },
      { id: "heavy-repo", text: "Heavy Repo Mode cached session rows git metadata large repos slow filesystems" },
      { id: "sleep-inhibitor", text: "Prevent Sleep During Generation caffeinate awake macOS" },
      { id: "session-data", text: "Session Data Export All Sessions Import Sessions portable archive paths" },
    ],
  },
  {
    id: "pushover",
    title: "Push Notifications (Pushover)",
    description: "Get push notifications on your phone when sessions need attention. Get credentials at pushover.net.",
    aliases: ["push", "phone", "alerts", "notification", "credentials"],
    items: [
      { id: "credentials", text: "User Key API Token Base URL Pushover credentials" },
      { id: "delay", text: "Delay seconds before sending push notification" },
      { id: "enabled", text: "Enabled Pushover notifications" },
      { id: "event-types", text: "Event types needs user input ready for review errors filters" },
      { id: "test", text: "Send Test save Pushover configured" },
    ],
  },
  {
    id: "auto-approval",
    title: "Auto-Approval (LLM)",
    description:
      "When enabled, permission requests are first evaluated by a fast LLM against your project-specific criteria.",
    aliases: ["approval", "permission", "llm", "rules", "model", "concurrency", "timeout"],
    items: [
      { id: "enabled", text: "Enabled auto approval permission requests" },
      { id: "model", text: "Model Haiku Sonnet session model LLM" },
      { id: "limits", text: "Max concurrency timeout seconds" },
      { id: "project-rules", text: "Project Rules criteria project paths add rule folder" },
      { id: "debug", text: "Debug panel auto approval logs" },
    ],
  },
  {
    id: "session-namer",
    title: "Session Namer",
    description: "Automatically name sessions based on their content.",
    aliases: ["auto namer", "name", "naming", "openai", "model", "api key"],
    items: [
      { id: "enabled", text: "Enabled auto namer session names" },
      { id: "backend", text: "Backend Claude CLI OpenAI-compatible API" },
      { id: "model", text: "Model API Key Base URL naming backend" },
      { id: "debug", text: "Session Namer Debug logs" },
    ],
  },
  {
    id: "voice-transcription",
    title: "Voice Transcription",
    description: "Configure the OpenAI-compatible Whisper API for voice-to-text input.",
    aliases: ["voice", "stt", "speech", "transcribe", "whisper", "audio", "dictation"],
    items: [
      { id: "credentials", text: "API Key Base URL voice transcription OpenAI Whisper" },
      { id: "models", text: "STT Model Enhancement Model transcribe" },
      { id: "enhancement", text: "Enable Enhancement Enhancement Style prose bullet points" },
      { id: "vocabulary", text: "Custom Vocabulary terms model mishears vocabulary hints" },
      { id: "tester", text: "Enhancement Tester debug panel" },
    ],
  },
  {
    id: "server",
    title: "Server & Diagnostics",
    aliases: ["logs", "restart", "diagnostics", "server"],
    items: [
      { id: "logs", text: "Log Viewer structured server runtime logs filtering Takode CLI" },
      { id: "restart", text: "Restart Server process reconnect sessions" },
    ],
  },
];

function sectionSearchText(section: SettingsSectionMeta): string {
  return [section.title, section.description, ...(section.aliases ?? [])].filter(Boolean).join(" ");
}

function itemSearchText(item: SettingItemMeta): string {
  return [item.text, ...(item.aliases ?? [])].filter(Boolean).join(" ");
}

export function computeSettingsSearchResults(query: string): SettingsSearchResults {
  const trimmed = query.trim();
  const visibleSectionIds = new Set<SettingsSectionId>();
  const sectionMatchCounts = new Map<SettingsSectionId, number>();
  const visibleItemIds = new Map<SettingsSectionId, Set<string>>();

  if (!trimmed) {
    for (const section of SETTINGS_SECTIONS) {
      visibleSectionIds.add(section.id);
      sectionMatchCounts.set(section.id, 0);
      visibleItemIds.set(section.id, new Set(section.items.map((item) => item.id)));
    }
    return { query: trimmed, hasQuery: false, totalMatches: 0, visibleSectionIds, sectionMatchCounts, visibleItemIds };
  }

  let totalMatches = 0;
  for (const section of SETTINGS_SECTIONS) {
    const titleMatches = sessionSearchTextMatches(sectionSearchText(section), trimmed, "fuzzy");
    const itemMatches = section.items.filter((item) =>
      sessionSearchTextMatches(itemSearchText(item), trimmed, "fuzzy"),
    );
    const matchCount = itemMatches.length + (titleMatches ? 1 : 0);
    if (matchCount > 0) {
      visibleSectionIds.add(section.id);
      sectionMatchCounts.set(section.id, matchCount);
      visibleItemIds.set(section.id, new Set(itemMatches.map((item) => item.id)));
      totalMatches += matchCount;
    }
  }

  return { query: trimmed, hasQuery: true, totalMatches, visibleSectionIds, sectionMatchCounts, visibleItemIds };
}

export function useActiveSettingsSection(
  visibleSectionIds: SettingsSectionId[],
  scrollRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): [SettingsSectionId, Dispatch<SetStateAction<SettingsSectionId>>] {
  const fallbackSection = visibleSectionIds[0] ?? SETTINGS_SECTIONS[0].id;
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(fallbackSection);

  useEffect(() => {
    if (!visibleSectionIds.includes(activeSectionId)) {
      setActiveSectionId(fallbackSection);
    }
  }, [activeSectionId, fallbackSection, visibleSectionIds]);

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const root = scrollRef.current;
    if (!root) return;

    const visibleSet = new Set(visibleSectionIds);
    const nodes = SETTINGS_SECTIONS.map((section) => document.getElementById(settingsSectionDomId(section.id))).filter(
      (node): node is HTMLElement =>
        node !== null && visibleSet.has(node.dataset.settingsSectionId as SettingsSectionId),
    );
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
        const next = visible[0]?.target.getAttribute("data-settings-section-id") as SettingsSectionId | null;
        if (next) setActiveSectionId(next);
      },
      { root, rootMargin: "-12% 0px -72% 0px", threshold: [0, 0.1, 0.25] },
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [enabled, scrollRef, visibleSectionIds]);

  return [activeSectionId, setActiveSectionId];
}

export function settingsSectionDomId(id: SettingsSectionId | string): string {
  return `settings-section-${id}`;
}

export function useSettingsSearchNavigation(scrollRef: RefObject<HTMLElement | null>, isActive: boolean) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => computeSettingsSearchResults(query), [query]);
  const visibleSectionIds = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => results.visibleSectionIds.has(section.id)).map((section) => section.id),
    [results.visibleSectionIds],
  );
  const [activeSectionId, setActiveSectionId] = useActiveSettingsSection(visibleSectionIds, scrollRef, isActive);

  function sectionSearch(id: SettingsSectionId) {
    return {
      hidden: !results.visibleSectionIds.has(id),
      searchQuery: results.query,
      matchCount: results.sectionMatchCounts.get(id) ?? 0,
    };
  }

  function childSectionSearch(id: SettingsSectionId) {
    return { results, id };
  }

  function rowHidden(sectionId: SettingsSectionId, itemId: string) {
    if (!results.hasQuery) return false;
    const visibleItems = results.visibleItemIds.get(sectionId);
    if (!visibleItems || visibleItems.size === 0) return false;
    return !visibleItems.has(itemId);
  }

  function jumpToSection(id: SettingsSectionId) {
    setActiveSectionId(id);
    document.getElementById(settingsSectionDomId(id))?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  return { query, setQuery, results, activeSectionId, sectionSearch, childSectionSearch, rowHidden, jumpToSection };
}

export function SettingsSearchControls({
  query,
  setQuery,
  results,
  activeSectionId,
  onJump,
}: {
  query: string;
  setQuery: (query: string) => void;
  results: SettingsSearchResults;
  activeSectionId: SettingsSectionId;
  onJump: (id: SettingsSectionId) => void;
}) {
  const visibleSections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => results.visibleSectionIds.has(section.id)),
    [results.visibleSectionIds],
  );

  return (
    <div className="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 py-3 bg-cc-bg/95 backdrop-blur border-y border-cc-border/60">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="search"
          aria-label="Search settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search settings..."
          className="min-w-0 flex-1 px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
        />
        <select
          aria-label="Jump to settings section"
          value={activeSectionId}
          onChange={(event) => onJump(event.target.value as SettingsSectionId)}
          className="lg:hidden px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
        >
          {visibleSections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.title}
              {results.hasQuery ? ` (${results.sectionMatchCounts.get(section.id) ?? 0})` : ""}
            </option>
          ))}
        </select>
      </div>
      {results.hasQuery && results.totalMatches === 0 && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-cc-card border border-cc-border text-sm text-cc-muted">
          No settings match "{results.query}".
        </div>
      )}
    </div>
  );
}

export function SettingsSectionNav({
  results,
  activeSectionId,
  onJump,
}: {
  results: SettingsSearchResults;
  activeSectionId: SettingsSectionId;
  onJump: (id: SettingsSectionId) => void;
}) {
  const visibleSections = SETTINGS_SECTIONS.filter((section) => results.visibleSectionIds.has(section.id));

  return (
    <nav className="hidden lg:block sticky top-24 self-start max-h-[calc(100dvh-7rem)] overflow-y-auto pr-2">
      <div className="space-y-1 border-l border-cc-border pl-2">
        {visibleSections.map((section) => {
          const active = section.id === activeSectionId;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onJump(section.id)}
              className={`w-full flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors cursor-pointer ${
                active ? "bg-cc-primary/12 text-cc-primary" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
            >
              <span className="truncate">{section.title}</span>
              {results.hasQuery && (
                <span className="shrink-0 rounded-full bg-cc-hover px-1.5 py-0.5 text-[10px] text-cc-muted">
                  {results.sectionMatchCounts.get(section.id) ?? 0}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
