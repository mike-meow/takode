import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api.js";
import { CODEX_LOCAL_SLASH_COMMANDS } from "../../shared/codex-slash-commands.js";
import type { ChatMessage, CodexAppReference, CodexSkillReference, QuestmasterTask, SdkSessionInfo } from "../types.js";
import { useStore } from "../store.js";
import {
  findAutocompleteTokenEnd,
  isCaretInsideAutocompleteRange,
  replaceAutocompleteRange,
  type ActiveAutocompleteRange,
} from "./composer-autocomplete-ranges.js";
import {
  DOLLAR_QUERY_PATTERN,
  REFERENCE_MENU_LIMIT,
  computeRecentAutocompleteBoosts,
  overlayCurrentAutocompleteBoosts,
  detectReferenceTrigger,
  getSessionSuggestionPreview,
  toAppMentionInsertText,
  toSkillMentionInsertText,
  type CommandItem,
  type ReferenceSuggestion,
} from "./composer-reference-utils.js";

type MentionResult = { relativePath: string; absolutePath: string; fileName: string };

interface AutocompleteSessionView {
  cwd?: string | null;
  repoRoot?: string | null;
  slashCommands: string[];
  skills: string[];
  skillMetadata: CodexSkillReference[];
  apps: CodexAppReference[];
}

interface UseComposerAutocompleteArgs {
  text: string;
  setText: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  sessionId: string;
  isCodex: boolean;
  isConnected: boolean;
  sessionView: AutocompleteSessionView;
  messages: ChatMessage[];
}

const EMPTY_QUESTS: QuestmasterTask[] = [];
const EMPTY_SDK_SESSIONS: SdkSessionInfo[] = [];
const EMPTY_SESSION_NAMES = new Map<string, string>();

function closeMenuRef(ref: RefObject<HTMLDivElement | null>, target: EventTarget | null): boolean {
  return !!ref.current && !ref.current.contains(target as Node);
}

function sortAutocompleteCommands(
  commands: CommandItem[],
  query: string,
  skillBoosts: ReadonlyMap<string, number>,
  skillGroupOrder: "before" | "after",
): CommandItem[] {
  const normalizedQuery = query.toLowerCase();
  const nonSkillGroup = skillGroupOrder === "before" ? 1 : 0;
  const skillGroup = skillGroupOrder === "before" ? 0 : 1;

  return [...commands]
    .map((command, index) => ({
      command,
      index,
      group: command.type === "skill" ? skillGroup : nonSkillGroup,
      recentBoost: command.type === "skill" ? (skillBoosts.get(command.name.trim().toLowerCase()) ?? 0) : 0,
    }))
    .sort((left, right) => {
      if (left.group !== right.group) return left.group - right.group;
      if (left.group === nonSkillGroup) return left.index - right.index;

      const leftExact = Number(normalizedQuery !== "" && left.command.name.toLowerCase() === normalizedQuery);
      const rightExact = Number(normalizedQuery !== "" && right.command.name.toLowerCase() === normalizedQuery);
      if (leftExact !== rightExact) return rightExact - leftExact;
      if (left.recentBoost !== right.recentBoost) return right.recentBoost - left.recentBoost;
      return left.index - right.index;
    })
    .map((entry) => entry.command);
}

export function useComposerAutocomplete({
  text,
  setText,
  textareaRef,
  sessionId,
  isCodex,
  isConnected,
  sessionView,
  messages,
}: UseComposerAutocompleteArgs) {
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [dollarMenuOpen, setDollarMenuOpen] = useState(false);
  const [dollarMenuIndex, setDollarMenuIndex] = useState(0);
  const [dollarQuery, setDollarQuery] = useState("");
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  const [referenceMenuIndex, setReferenceMenuIndex] = useState(0);
  const [referenceQuery, setReferenceQuery] = useState("");
  const [referenceKind, setReferenceKind] = useState<"quest" | "session" | null>(null);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionResults, setMentionResults] = useState<MentionResult[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const dollarMenuRef = useRef<HTMLDivElement>(null);
  const referenceMenuRef = useRef<HTMLDivElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const slashAnchorRef = useRef<number>(-1);
  const dollarAnchorRef = useRef<number>(-1);
  const referenceAnchorRef = useRef<number>(-1);
  const mentionAnchorRef = useRef<number>(-1);
  const slashRangeRef = useRef<ActiveAutocompleteRange | null>(null);
  const dollarRangeRef = useRef<ActiveAutocompleteRange | null>(null);
  const referenceRangeRef = useRef<ActiveAutocompleteRange | null>(null);
  const mentionRangeRef = useRef<ActiveAutocompleteRange | null>(null);
  const mentionAbortRef = useRef<AbortController | null>(null);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedCodexSkillRefreshSessionRef = useRef<string | null>(null);
  const quests = useStore((s) =>
    referenceMenuOpen && referenceKind === "quest" ? (s.quests ?? EMPTY_QUESTS) : EMPTY_QUESTS,
  );
  const sessionReferenceData = useStore(
    useShallow((s) => {
      if (!referenceMenuOpen || referenceKind !== "session") {
        return {
          sdkSessions: EMPTY_SDK_SESSIONS,
          sessionNames: EMPTY_SESSION_NAMES,
        };
      }
      return {
        sdkSessions: s.sdkSessions ?? EMPTY_SDK_SESSIONS,
        sessionNames: s.sessionNames,
      };
    }),
  );
  const sdkSessions = sessionReferenceData.sdkSessions;
  const sessionNames = sessionReferenceData.sessionNames;

  const closeAutocompleteMenus = useCallback(() => {
    setSlashMenuOpen(false);
    slashAnchorRef.current = -1;
    slashRangeRef.current = null;
    setDollarMenuOpen(false);
    setDollarQuery("");
    dollarAnchorRef.current = -1;
    dollarRangeRef.current = null;
    setReferenceMenuOpen(false);
    setReferenceKind(null);
    setReferenceQuery("");
    referenceAnchorRef.current = -1;
    referenceRangeRef.current = null;
    setMentionMenuOpen(false);
    setMentionResults([]);
    mentionAnchorRef.current = -1;
    mentionRangeRef.current = null;
  }, []);

  const allCommands = useMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [];
    const seen = new Set<string>();
    const pushCommand = (name: string, type: "command" | "skill") => {
      const normalized = name.trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      cmds.push({ name: normalized, type, trigger: "/", insertText: `/${normalized}` });
    };
    if (isCodex) {
      for (const cmd of CODEX_LOCAL_SLASH_COMMANDS) pushCommand(cmd, "command");
    }
    for (const cmd of sessionView.slashCommands) pushCommand(cmd, "command");
    for (const skill of sessionView.skills) pushCommand(skill, "skill");
    return cmds;
  }, [isCodex, sessionView.skills, sessionView.slashCommands]);

  const dollarCommands = useMemo<CommandItem[]>(() => {
    if (!isCodex) return [];
    const cmds: CommandItem[] = [];
    const seen = new Set<string>();
    const skillMetadataByName = new Map<string, CodexSkillReference>();
    for (const skill of sessionView.skillMetadata) {
      const name = skill.name.trim();
      if (name && !skillMetadataByName.has(name)) skillMetadataByName.set(name, skill);
    }
    const pushSkill = (name: string, skill?: CodexSkillReference) => {
      const normalized = name.trim();
      if (!normalized || seen.has(`skill:${normalized}`)) return;
      seen.add(`skill:${normalized}`);
      cmds.push({
        name: normalized,
        type: "skill",
        trigger: "$",
        insertText: toSkillMentionInsertText(skill ?? { name: normalized, path: "" }),
        ...(skill?.description ? { description: skill.description } : {}),
      });
    };
    const pushApp = (app: CodexAppReference) => {
      const id = app.id.trim();
      const name = app.name.trim();
      if (!id || !name || seen.has(`app:${id}`)) return;
      seen.add(`app:${id}`);
      cmds.push({
        name,
        type: "app",
        trigger: "$",
        insertText: toAppMentionInsertText(app),
        ...(app.description ? { description: app.description } : {}),
      });
    };
    for (const skill of sessionView.skills) pushSkill(skill, skillMetadataByName.get(skill.trim()));
    for (const skill of skillMetadataByName.values()) pushSkill(skill.name, skill);
    for (const app of sessionView.apps) pushApp(app);
    return cmds;
  }, [isCodex, sessionView.apps, sessionView.skillMetadata, sessionView.skills]);

  useEffect(() => {
    if (!isCodex || !isConnected) return;
    if (sessionView.skillMetadata.length > 0 || sessionView.apps.length > 0) return;
    if (requestedCodexSkillRefreshSessionRef.current === sessionId) return;
    requestedCodexSkillRefreshSessionRef.current = sessionId;
    api.refreshSessionSkills(sessionId).catch(() => {});
  }, [isCodex, isConnected, sessionId, sessionView.apps, sessionView.skillMetadata]);

  const detectSlashQuery = useCallback(
    (inputText: string, cursorPos: number) => {
      if (allCommands.length === 0) {
        setSlashMenuOpen(false);
        slashAnchorRef.current = -1;
        slashRangeRef.current = null;
        return;
      }

      let slashPos = -1;
      for (let i = cursorPos - 1; i >= 0; i -= 1) {
        const ch = inputText[i];
        if (ch === " " || ch === "\n" || ch === "\t") break;
        if (ch === "/") {
          if (i === 0 || /\s/.test(inputText[i - 1])) slashPos = i;
          break;
        }
      }

      if (slashPos === -1) {
        setSlashMenuOpen(false);
        slashAnchorRef.current = -1;
        slashRangeRef.current = null;
        return;
      }

      const tokenEnd = findAutocompleteTokenEnd(inputText, slashPos);
      slashAnchorRef.current = slashPos;
      slashRangeRef.current = { replaceStart: slashPos, tokenStart: slashPos, replaceEnd: tokenEnd };
      if (!slashMenuOpen) setSlashMenuIndex(0);
      setSlashMenuOpen(true);
    },
    [allCommands.length, slashMenuOpen],
  );

  useEffect(() => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    detectSlashQuery(text, cursorPos);
  }, [detectSlashQuery, textareaRef, text]);

  const recencySkillNames = useMemo(
    () => [...sessionView.skills, ...sessionView.skillMetadata.map((skill) => skill.name)],
    [sessionView.skillMetadata, sessionView.skills],
  );
  const historyAutocompleteBoosts = useMemo(
    () => computeRecentAutocompleteBoosts(messages, recencySkillNames),
    [messages, recencySkillNames],
  );
  const recentAutocompleteBoosts = useMemo(
    () => overlayCurrentAutocompleteBoosts(historyAutocompleteBoosts, text, recencySkillNames),
    [historyAutocompleteBoosts, recencySkillNames, text],
  );

  const filteredCommands = useMemo(() => {
    if (!slashMenuOpen || slashAnchorRef.current === -1) return [];
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const query = text.slice(slashAnchorRef.current + 1, cursorPos).toLowerCase();
    const filtered = query === "" ? allCommands : allCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
    return sortAutocompleteCommands(filtered, query, recentAutocompleteBoosts.skillBoosts, "after");
  }, [allCommands, recentAutocompleteBoosts.skillBoosts, slashMenuOpen, textareaRef, text]);

  useEffect(() => {
    if (slashMenuIndex >= filteredCommands.length) {
      setSlashMenuIndex(Math.max(0, filteredCommands.length - 1));
    }
  }, [filteredCommands.length, slashMenuIndex]);

  useEffect(() => {
    if (!menuRef.current || !slashMenuOpen) return;
    menuRef.current.querySelectorAll("[data-cmd-index]")[slashMenuIndex]?.scrollIntoView({ block: "nearest" });
  }, [slashMenuIndex, slashMenuOpen]);

  const filteredDollarCommands = useMemo(() => {
    if (!dollarMenuOpen) return [];
    const query = dollarQuery.toLowerCase();
    const filtered =
      query === "" ? dollarCommands : dollarCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
    return sortAutocompleteCommands(filtered, query, recentAutocompleteBoosts.skillBoosts, "before");
  }, [dollarCommands, dollarMenuOpen, dollarQuery, recentAutocompleteBoosts.skillBoosts]);

  const detectDollarQuery = useCallback(
    (inputText: string, cursorPos: number) => {
      if (!isCodex || dollarCommands.length === 0) {
        setDollarMenuOpen(false);
        setDollarQuery("");
        dollarAnchorRef.current = -1;
        dollarRangeRef.current = null;
        return;
      }

      let dollarPos = -1;
      for (let i = cursorPos - 1; i >= 0; i -= 1) {
        const ch = inputText[i];
        if (ch === " " || ch === "\n" || ch === "\t") break;
        if (ch === "$") {
          if (i === 0 || /[\s({]/.test(inputText[i - 1])) dollarPos = i;
          break;
        }
      }

      const tokenEnd = dollarPos === -1 ? -1 : findAutocompleteTokenEnd(inputText, dollarPos);
      const query = dollarPos === -1 ? "" : inputText.slice(dollarPos + 1, cursorPos);
      const fullQuery = dollarPos === -1 ? "" : inputText.slice(dollarPos + 1, tokenEnd);
      const shouldOpen = dollarPos !== -1 && (fullQuery === "" || DOLLAR_QUERY_PATTERN.test(fullQuery));
      if (!shouldOpen) {
        setDollarMenuOpen(false);
        dollarAnchorRef.current = -1;
        dollarRangeRef.current = null;
        setDollarQuery("");
        return;
      }

      dollarAnchorRef.current = dollarPos;
      dollarRangeRef.current = { replaceStart: dollarPos, tokenStart: dollarPos, replaceEnd: tokenEnd };
      setDollarQuery(query);
      if (!dollarMenuOpen || dollarQuery !== query) setDollarMenuIndex(0);
      setDollarMenuOpen(true);
    },
    [dollarCommands.length, dollarMenuOpen, dollarQuery, isCodex],
  );

  useEffect(() => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    detectDollarQuery(text, cursorPos);
  }, [detectDollarQuery, textareaRef, text]);

  useEffect(() => {
    if (dollarMenuIndex >= filteredDollarCommands.length) {
      setDollarMenuIndex(Math.max(0, filteredDollarCommands.length - 1));
    }
  }, [dollarMenuIndex, filteredDollarCommands.length]);

  useEffect(() => {
    if (!dollarMenuRef.current || !dollarMenuOpen) return;
    dollarMenuRef.current
      .querySelectorAll("[data-dollar-index]")
      [dollarMenuIndex]?.scrollIntoView({ block: "nearest" });
  }, [dollarMenuIndex, dollarMenuOpen]);

  useEffect(() => {
    if (!dollarMenuOpen) return;
    function handlePointerDown(e: PointerEvent) {
      if (closeMenuRef(dollarMenuRef, e.target)) {
        setDollarMenuOpen(false);
        setDollarQuery("");
        dollarAnchorRef.current = -1;
        dollarRangeRef.current = null;
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [dollarMenuOpen]);

  const filteredReferenceSuggestions = useMemo<ReferenceSuggestion[]>(() => {
    if (!referenceMenuOpen || referenceKind == null) return [];
    if (referenceKind === "quest") {
      const fullQuery = `q-${referenceQuery}`.toLowerCase();
      return quests
        .filter((quest) => referenceQuery === "" || quest.questId.toLowerCase().startsWith(fullQuery))
        .map((quest) => ({
          key: quest.questId,
          kind: "quest" as const,
          rawRef: quest.questId,
          preview: quest.title,
          insertText: quest.questId,
          searchText: `${quest.questId} ${quest.title}`.toLowerCase(),
          recentBoost: recentAutocompleteBoosts.questBoosts.get(quest.questId.toLowerCase()) ?? 0,
          tieBreaker: Number.parseInt(quest.questId.replace(/^q-/, ""), 10) || 0,
        }))
        .sort((left, right) => {
          const leftExact = Number(left.rawRef.toLowerCase() === fullQuery);
          const rightExact = Number(right.rawRef.toLowerCase() === fullQuery);
          if (leftExact !== rightExact) return rightExact - leftExact;
          if (left.recentBoost !== right.recentBoost) return right.recentBoost - left.recentBoost;
          return right.tieBreaker - left.tieBreaker;
        })
        .slice(0, REFERENCE_MENU_LIMIT);
    }

    const seenSessionNums = new Set<number>();
    const normalizedQuery = referenceQuery.toLowerCase();
    return sdkSessions
      .filter((session) => session.sessionNum != null)
      .filter((session) => {
        const sessionNum = session.sessionNum!;
        if (seenSessionNums.has(sessionNum)) return false;
        seenSessionNums.add(sessionNum);
        return true;
      })
      .map((session) => {
        const sessionNum = session.sessionNum!;
        const rawRef = `#${sessionNum}`;
        const preview = getSessionSuggestionPreview(session, sessionNames.get(session.sessionId));
        return {
          key: session.sessionId,
          kind: "session" as const,
          rawRef,
          preview,
          insertText: rawRef,
          searchText: `${rawRef} ${preview}`.toLowerCase(),
          recentBoost: recentAutocompleteBoosts.sessionBoosts.get(sessionNum) ?? 0,
          tieBreaker: session.lastActivityAt ?? session.createdAt ?? sessionNum,
        };
      })
      .filter((session) => normalizedQuery === "" || session.rawRef.slice(1).startsWith(normalizedQuery))
      .sort((left, right) => {
        const leftExact = Number(left.rawRef.slice(1).toLowerCase() === normalizedQuery);
        const rightExact = Number(right.rawRef.slice(1).toLowerCase() === normalizedQuery);
        if (leftExact !== rightExact) return rightExact - leftExact;
        if (left.recentBoost !== right.recentBoost) return right.recentBoost - left.recentBoost;
        return right.tieBreaker - left.tieBreaker;
      })
      .slice(0, REFERENCE_MENU_LIMIT);
  }, [quests, recentAutocompleteBoosts, referenceKind, referenceMenuOpen, referenceQuery, sdkSessions, sessionNames]);

  const detectReferenceQuery = useCallback(
    (inputText: string, cursorPos: number) => {
      const match = detectReferenceTrigger(inputText, cursorPos);
      if (!match) {
        setReferenceMenuOpen(false);
        setReferenceKind(null);
        setReferenceQuery("");
        referenceAnchorRef.current = -1;
        referenceRangeRef.current = null;
        return;
      }

      const tokenStart = /[[({]/.test(inputText[match.replacementStart] ?? "")
        ? match.replacementStart + 1
        : match.replacementStart;
      const tokenEnd = findAutocompleteTokenEnd(inputText, tokenStart);
      const fullQuery =
        match.kind === "quest" ? inputText.slice(tokenStart + 2, tokenEnd) : inputText.slice(tokenStart + 1, tokenEnd);
      if (!/^\d*$/.test(fullQuery)) {
        setReferenceMenuOpen(false);
        setReferenceKind(null);
        setReferenceQuery("");
        referenceAnchorRef.current = -1;
        referenceRangeRef.current = null;
        return;
      }

      referenceAnchorRef.current = match.replacementStart;
      referenceRangeRef.current = { replaceStart: match.replacementStart, tokenStart, replaceEnd: tokenEnd };
      setReferenceKind(match.kind);
      setReferenceQuery(match.query);
      if (!referenceMenuOpen || referenceKind !== match.kind || referenceQuery !== match.query) {
        setReferenceMenuIndex(0);
      }
      setReferenceMenuOpen(true);
    },
    [referenceKind, referenceMenuOpen, referenceQuery],
  );

  useEffect(() => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    detectReferenceQuery(text, cursorPos);
  }, [detectReferenceQuery, textareaRef, text]);

  useEffect(() => {
    if (referenceMenuIndex >= filteredReferenceSuggestions.length) {
      setReferenceMenuIndex(Math.max(0, filteredReferenceSuggestions.length - 1));
    }
  }, [filteredReferenceSuggestions.length, referenceMenuIndex]);

  useEffect(() => {
    if (!referenceMenuRef.current || !referenceMenuOpen) return;
    referenceMenuRef.current
      .querySelectorAll("[data-reference-index]")
      [referenceMenuIndex]?.scrollIntoView({ block: "nearest" });
  }, [referenceMenuIndex, referenceMenuOpen]);

  useEffect(() => {
    if (!referenceMenuOpen) return;
    function handlePointerDown(e: PointerEvent) {
      if (closeMenuRef(referenceMenuRef, e.target)) {
        setReferenceMenuOpen(false);
        setReferenceKind(null);
        setReferenceQuery("");
        referenceAnchorRef.current = -1;
        referenceRangeRef.current = null;
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [referenceMenuOpen]);

  const mentionSearchRoot = useMemo(() => {
    const cwd = sessionView.cwd;
    const repoRoot = sessionView.repoRoot;
    if (repoRoot && cwd?.startsWith(repoRoot + "/")) return repoRoot;
    return cwd || repoRoot || null;
  }, [sessionView.cwd, sessionView.repoRoot]);

  const detectMentionQuery = useCallback(
    (inputText: string, cursorPos: number) => {
      let atPos = -1;
      for (let i = cursorPos - 1; i >= 0; i -= 1) {
        const ch = inputText[i];
        if (ch === " " || ch === "\n" || ch === "\t") break;
        if (ch === "@") {
          if (i === 0 || /\s/.test(inputText[i - 1])) atPos = i;
          break;
        }
      }

      if (atPos === -1) {
        if (mentionMenuOpen) {
          setMentionMenuOpen(false);
          setMentionResults([]);
        }
        mentionAnchorRef.current = -1;
        mentionRangeRef.current = null;
        return;
      }

      const query = inputText.slice(atPos + 1, cursorPos);
      const tokenEnd = findAutocompleteTokenEnd(inputText, atPos);
      mentionAnchorRef.current = atPos;
      mentionRangeRef.current = { replaceStart: atPos, tokenStart: atPos, replaceEnd: tokenEnd };
      setMentionQuery(query);
      if (!mentionMenuOpen) {
        setMentionMenuOpen(true);
        setMentionIndex(0);
      }
      if (query.length < 3) {
        mentionAbortRef.current?.abort();
        if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
        setMentionResults([]);
        setMentionLoading(false);
        return;
      }

      if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
      mentionAbortRef.current?.abort();
      setMentionLoading(true);
      mentionDebounceRef.current = setTimeout(async () => {
        if (!mentionSearchRoot) {
          setMentionLoading(false);
          return;
        }
        const controller = new AbortController();
        mentionAbortRef.current = controller;
        try {
          const { results } = await api.searchFiles(mentionSearchRoot, query, controller.signal);
          if (!controller.signal.aborted) {
            setMentionResults(results);
            setMentionIndex(0);
            setMentionLoading(false);
          }
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (!controller.signal.aborted) {
            setMentionResults([]);
            setMentionLoading(false);
          }
        }
      }, 150);
    },
    [mentionMenuOpen, mentionSearchRoot],
  );

  useEffect(() => {
    if (!mentionMenuOpen) return;
    function handlePointerDown(e: PointerEvent) {
      if (closeMenuRef(mentionMenuRef, e.target)) setMentionMenuOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [mentionMenuOpen]);

  useEffect(() => {
    if (mentionIndex >= mentionResults.length) {
      setMentionIndex(Math.max(0, mentionResults.length - 1));
    }
  }, [mentionIndex, mentionResults.length]);

  useEffect(() => {
    if (!mentionMenuRef.current || !mentionMenuOpen) return;
    mentionMenuRef.current.querySelectorAll("[data-mention-index]")[mentionIndex]?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, mentionMenuOpen]);

  useEffect(() => {
    return () => {
      if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
      mentionAbortRef.current?.abort();
    };
  }, []);

  const selectMention = useCallback(
    (result: { relativePath: string }) => {
      const selectionStart = textareaRef.current?.selectionStart ?? text.length;
      const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;
      const activeRange = mentionRangeRef.current;
      if (!isCaretInsideAutocompleteRange(selectionStart, selectionEnd, activeRange)) {
        setMentionMenuOpen(false);
        setMentionResults([]);
        mentionAnchorRef.current = -1;
        mentionRangeRef.current = null;
        return;
      }
      const replacement = replaceAutocompleteRange(text, activeRange, `@${result.relativePath}`);
      setText(replacement.nextText);
      setMentionMenuOpen(false);
      setMentionResults([]);
      mentionAnchorRef.current = -1;
      mentionRangeRef.current = null;
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(replacement.cursorPos, replacement.cursorPos);
        textareaRef.current?.focus();
      });
    },
    [setText, textareaRef, text],
  );

  const selectReference = useCallback(
    (suggestion: ReferenceSuggestion) => {
      const selectionStart = textareaRef.current?.selectionStart ?? text.length;
      const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;
      const activeRange = referenceRangeRef.current;
      if (!isCaretInsideAutocompleteRange(selectionStart, selectionEnd, activeRange)) {
        setReferenceMenuOpen(false);
        setReferenceKind(null);
        setReferenceQuery("");
        referenceAnchorRef.current = -1;
        referenceRangeRef.current = null;
        return;
      }
      const replacement = replaceAutocompleteRange(text, activeRange, suggestion.insertText);
      setText(replacement.nextText);
      setReferenceMenuOpen(false);
      setReferenceKind(null);
      setReferenceQuery("");
      referenceAnchorRef.current = -1;
      referenceRangeRef.current = null;
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(replacement.cursorPos, replacement.cursorPos);
        textareaRef.current?.focus();
      });
    },
    [setText, textareaRef, text],
  );

  const selectCommand = useCallback(
    (cmd: CommandItem) => {
      if (cmd.trigger === "$") {
        const selectionStart = textareaRef.current?.selectionStart ?? text.length;
        const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;
        const activeRange = dollarRangeRef.current;
        if (!isCaretInsideAutocompleteRange(selectionStart, selectionEnd, activeRange)) {
          setDollarMenuOpen(false);
          setDollarQuery("");
          dollarAnchorRef.current = -1;
          dollarRangeRef.current = null;
          return;
        }
        const replacement = replaceAutocompleteRange(text, activeRange, cmd.insertText);
        setText(replacement.nextText);
        setDollarMenuOpen(false);
        setDollarQuery("");
        dollarAnchorRef.current = -1;
        dollarRangeRef.current = null;
        requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(replacement.cursorPos, replacement.cursorPos);
          textareaRef.current?.focus();
        });
        return;
      }

      const selectionStart = textareaRef.current?.selectionStart ?? text.length;
      const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;
      const activeRange = slashRangeRef.current;
      if (!isCaretInsideAutocompleteRange(selectionStart, selectionEnd, activeRange)) {
        setSlashMenuOpen(false);
        slashAnchorRef.current = -1;
        slashRangeRef.current = null;
        return;
      }
      const replacement = replaceAutocompleteRange(text, activeRange, cmd.insertText);
      setText(replacement.nextText);
      setSlashMenuOpen(false);
      slashAnchorRef.current = -1;
      slashRangeRef.current = null;
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(replacement.cursorPos, replacement.cursorPos);
        textareaRef.current?.focus();
      });
    },
    [setText, textareaRef, text],
  );

  const handleAutocompleteInput = useCallback(
    (inputText: string, cursorPos: number) => {
      detectMentionQuery(inputText, cursorPos);
      detectSlashQuery(inputText, cursorPos);
      detectDollarQuery(inputText, cursorPos);
      detectReferenceQuery(inputText, cursorPos);
    },
    [detectDollarQuery, detectMentionQuery, detectReferenceQuery, detectSlashQuery],
  );

  const handleAutocompleteSelectionChange = useCallback(
    (e: SyntheticEvent<HTMLTextAreaElement>) => {
      const key = "key" in e ? (e as KeyboardEvent<HTMLTextAreaElement>).key : "";
      if (
        (key === "ArrowDown" || key === "ArrowUp") &&
        (slashMenuOpen || dollarMenuOpen || referenceMenuOpen || mentionMenuOpen)
      ) {
        return;
      }
      const target = e.currentTarget;
      if (target.selectionStart !== target.selectionEnd) {
        closeAutocompleteMenus();
        return;
      }
      handleAutocompleteInput(target.value, target.selectionStart);
    },
    [
      closeAutocompleteMenus,
      dollarMenuOpen,
      handleAutocompleteInput,
      mentionMenuOpen,
      referenceMenuOpen,
      slashMenuOpen,
    ],
  );

  const handleAutocompleteKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashMenuOpen && filteredCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashMenuIndex((i) => (i + 1) % filteredCommands.length);
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
          return true;
        }
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          selectCommand(filteredCommands[slashMenuIndex]);
          return true;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
          e.preventDefault();
          selectCommand(filteredCommands[slashMenuIndex]);
          return true;
        }
      }
      if (slashMenuOpen && e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        slashAnchorRef.current = -1;
        slashRangeRef.current = null;
        return true;
      }

      if (dollarMenuOpen && filteredDollarCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setDollarMenuIndex((i) => (i + 1) % filteredDollarCommands.length);
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setDollarMenuIndex((i) => (i - 1 + filteredDollarCommands.length) % filteredDollarCommands.length);
          return true;
        }
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          selectCommand(filteredDollarCommands[dollarMenuIndex]);
          return true;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          selectCommand(filteredDollarCommands[dollarMenuIndex]);
          return true;
        }
      }
      if (dollarMenuOpen && e.key === "Escape") {
        e.preventDefault();
        setDollarMenuOpen(false);
        setDollarQuery("");
        dollarAnchorRef.current = -1;
        dollarRangeRef.current = null;
        return true;
      }

      if (referenceMenuOpen && filteredReferenceSuggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setReferenceMenuIndex((i) => (i + 1) % filteredReferenceSuggestions.length);
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setReferenceMenuIndex(
            (i) => (i - 1 + filteredReferenceSuggestions.length) % filteredReferenceSuggestions.length,
          );
          return true;
        }
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          selectReference(filteredReferenceSuggestions[referenceMenuIndex]);
          return true;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
          e.preventDefault();
          selectReference(filteredReferenceSuggestions[referenceMenuIndex]);
          return true;
        }
      }
      if (referenceMenuOpen && e.key === "Escape") {
        e.preventDefault();
        setReferenceMenuOpen(false);
        setReferenceKind(null);
        setReferenceQuery("");
        referenceAnchorRef.current = -1;
        referenceRangeRef.current = null;
        return true;
      }

      if (mentionMenuOpen && mentionResults.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % mentionResults.length);
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + mentionResults.length) % mentionResults.length);
          return true;
        }
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          selectMention(mentionResults[mentionIndex]);
          return true;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
          e.preventDefault();
          selectMention(mentionResults[mentionIndex]);
          return true;
        }
      }
      if (mentionMenuOpen && e.key === "Escape") {
        e.preventDefault();
        setMentionMenuOpen(false);
        setMentionResults([]);
        mentionAnchorRef.current = -1;
        mentionRangeRef.current = null;
        return true;
      }

      return false;
    },
    [
      dollarMenuIndex,
      dollarMenuOpen,
      filteredCommands,
      filteredDollarCommands,
      filteredReferenceSuggestions,
      mentionIndex,
      mentionMenuOpen,
      mentionResults,
      referenceMenuIndex,
      referenceMenuOpen,
      selectCommand,
      selectMention,
      selectReference,
      slashMenuIndex,
      slashMenuOpen,
    ],
  );

  return {
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
    handleAutocompleteInput,
    handleAutocompleteSelectionChange,
    handleAutocompleteKeyDown,
    closeAutocompleteMenus,
  };
}
