import { scopedGetItem, scopedSetItem } from "./scoped-storage.js";
import {
  deriveCodexAskPermission,
  deriveCodexUiMode,
  getDefaultMode,
  getDefaultModel,
  getModelsForBackend,
  getModesForBackend,
} from "./backends.js";

export type NewSessionBackend = "claude" | "codex";

const VALID_BACKENDS = new Set<NewSessionBackend>(["claude", "codex"]);

export interface NewSessionDefaults {
  backend: NewSessionBackend;
  model: string;
  mode: string;
  askPermission: boolean;
  sessionRole: "worker" | "leader";
  envSlug: string;
  cwd: string;
  useWorktree: boolean;
  codexInternetAccess: boolean;
  codexReasoningEffort: string;
}

export interface LastSessionCreationContext {
  cwd: string;
  treeGroupId?: string;
  newSessionDefaultsKey?: string;
}

type StoredGroupDefaults = Partial<NewSessionDefaults> & { updatedAt?: number };

const GROUP_DEFAULTS_KEY = "cc-new-session-groups";
const LAST_SESSION_CREATION_CONTEXT_KEY = "cc-last-session-creation-context";
const MAX_GROUP_DEFAULTS = 50;
const TREE_GROUP_DEFAULTS_PREFIX = "tree-group:";

function normalizeAskPermission(raw: boolean | null | undefined): boolean {
  return raw ?? true;
}

function normalizeMode(
  backend: NewSessionBackend,
  rawMode: string | null | undefined,
  rawAskPermission: boolean | null | undefined,
): { mode: string; askPermission: boolean } {
  if (backend === "codex" && (rawMode === "suggest" || rawMode === "bypassPermissions")) {
    return {
      mode: deriveCodexUiMode(rawMode),
      askPermission: deriveCodexAskPermission(rawMode),
    };
  }

  const modes = getModesForBackend(backend);
  const mode = rawMode && modes.some((entry) => entry.value === rawMode) ? rawMode : getDefaultMode(backend);
  return {
    mode,
    askPermission: normalizeAskPermission(rawAskPermission),
  };
}

function normalizeModel(backend: NewSessionBackend, rawModel: string | null | undefined): string {
  if (backend === "codex") {
    return rawModel ?? getDefaultModel(backend);
  }

  const models = getModelsForBackend(backend);
  return rawModel !== null && rawModel !== undefined && models.some((entry) => entry.value === rawModel)
    ? rawModel
    : getDefaultModel(backend);
}

function parseGroupDefaultsMap(): Record<string, StoredGroupDefaults> {
  try {
    const raw = scopedGetItem(GROUP_DEFAULTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, StoredGroupDefaults>;
  } catch {
    return {};
  }
}

function buildDefaults(candidate: Partial<NewSessionDefaults>): NewSessionDefaults {
  const backend = candidate.backend && VALID_BACKENDS.has(candidate.backend) ? candidate.backend : "claude";
  const { mode, askPermission } = normalizeMode(backend, candidate.mode, candidate.askPermission);
  return {
    backend,
    model: normalizeModel(backend, candidate.model),
    mode,
    askPermission,
    sessionRole: candidate.sessionRole === "leader" ? "leader" : "worker",
    envSlug: candidate.envSlug ?? "",
    cwd: candidate.cwd?.trim() ?? "",
    useWorktree: candidate.useWorktree ?? true,
    codexInternetAccess: candidate.codexInternetAccess ?? false,
    codexReasoningEffort: candidate.codexReasoningEffort ?? "",
  };
}

function normalizeLastSessionCreationContext(
  candidate: Partial<LastSessionCreationContext> | null | undefined,
): LastSessionCreationContext | null {
  if (!candidate) return null;
  const cwd = candidate.cwd?.trim() ?? "";
  if (!cwd) return null;
  return {
    cwd,
    treeGroupId: candidate.treeGroupId?.trim() || undefined,
    newSessionDefaultsKey: candidate.newSessionDefaultsKey?.trim() || undefined,
  };
}

export function getGlobalNewSessionDefaults(): NewSessionDefaults {
  const raw = scopedGetItem("cc-backend");
  const backend = raw && VALID_BACKENDS.has(raw as NewSessionBackend) ? (raw as NewSessionBackend) : "claude";
  const askPermissionRaw = (() => {
    const stored = scopedGetItem("cc-ask-permission");
    return stored !== null ? stored === "true" : null;
  })();

  return buildDefaults({
    backend,
    model: scopedGetItem(`cc-model-${backend}`) ?? undefined,
    mode: scopedGetItem("cc-mode") ?? undefined,
    askPermission: askPermissionRaw ?? undefined,
    sessionRole: "worker",
    envSlug: scopedGetItem("cc-selected-env") || "",
    useWorktree: (() => {
      const stored = scopedGetItem("cc-worktree");
      return stored === null ? true : stored === "true";
    })(),
    codexInternetAccess: scopedGetItem("cc-codex-internet-access") === "1",
    codexReasoningEffort: scopedGetItem("cc-codex-reasoning-effort") ?? "",
  });
}

export function getTreeGroupNewSessionDefaultsKey(treeGroupId: string): string {
  const key = treeGroupId.trim();
  return key ? `${TREE_GROUP_DEFAULTS_PREFIX}${key}` : "";
}

export function getGroupNewSessionDefaults(groupKey: string): NewSessionDefaults {
  const globalDefaults = getGlobalNewSessionDefaults();
  const key = groupKey.trim();
  if (!key) return globalDefaults;

  const stored = parseGroupDefaultsMap()[key];
  if (!stored) return globalDefaults;
  return buildDefaults({ ...globalDefaults, ...stored });
}

export function saveGroupNewSessionDefaults(groupKey: string, defaults: NewSessionDefaults): void {
  const key = groupKey.trim();
  if (!key) return;

  const next = parseGroupDefaultsMap();
  next[key] = {
    ...buildDefaults(defaults),
    updatedAt: Date.now(),
  };

  const entries = Object.entries(next);
  if (entries.length > MAX_GROUP_DEFAULTS) {
    entries
      .sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))
      .slice(0, entries.length - MAX_GROUP_DEFAULTS)
      .forEach(([staleKey]) => {
        delete next[staleKey];
      });
  }

  scopedSetItem(GROUP_DEFAULTS_KEY, JSON.stringify(next));
}

export function getLastSessionCreationContext(): LastSessionCreationContext | null {
  try {
    const raw = scopedGetItem(LAST_SESSION_CREATION_CONTEXT_KEY);
    if (!raw) return null;
    return normalizeLastSessionCreationContext(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveLastSessionCreationContext(context: LastSessionCreationContext): void {
  const normalized = normalizeLastSessionCreationContext(context);
  if (!normalized) return;
  scopedSetItem(LAST_SESSION_CREATION_CONTEXT_KEY, JSON.stringify(normalized));
}
