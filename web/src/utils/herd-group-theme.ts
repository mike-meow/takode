import type { SessionItem } from "./project-grouping.js";

export interface HerdGroupBadgeTheme {
  token: string;
  textColor: string;
  borderColor: string;
  leaderBackground: string;
  herdBackground: string;
}

type HerdGroupSession = Pick<SessionItem, "id" | "isOrchestrator" | "herdedBy" | "sessionNum" | "createdAt">;

const HERD_GROUP_BADGE_PALETTE: HerdGroupBadgeTheme[] = [
  {
    token: "amber",
    textColor: "#f4c27a",
    borderColor: "rgba(232, 163, 75, 0.34)",
    leaderBackground: "rgba(232, 163, 75, 0.16)",
    herdBackground: "rgba(232, 163, 75, 0.1)",
  },
  {
    token: "sage",
    textColor: "#9fd6ac",
    borderColor: "rgba(119, 191, 139, 0.34)",
    leaderBackground: "rgba(119, 191, 139, 0.16)",
    herdBackground: "rgba(119, 191, 139, 0.1)",
  },
  {
    token: "teal",
    textColor: "#8fd2cb",
    borderColor: "rgba(87, 185, 175, 0.34)",
    leaderBackground: "rgba(87, 185, 175, 0.16)",
    herdBackground: "rgba(87, 185, 175, 0.1)",
  },
  {
    token: "sky",
    textColor: "#9ebff7",
    borderColor: "rgba(112, 156, 237, 0.34)",
    leaderBackground: "rgba(112, 156, 237, 0.16)",
    herdBackground: "rgba(112, 156, 237, 0.1)",
  },
  {
    token: "iris",
    textColor: "#b7a6f4",
    borderColor: "rgba(147, 121, 234, 0.34)",
    leaderBackground: "rgba(147, 121, 234, 0.16)",
    herdBackground: "rgba(147, 121, 234, 0.1)",
  },
  {
    token: "rose",
    textColor: "#f0abc1",
    borderColor: "rgba(225, 121, 160, 0.34)",
    leaderBackground: "rgba(225, 121, 160, 0.16)",
    herdBackground: "rgba(225, 121, 160, 0.1)",
  },
  {
    token: "copper",
    textColor: "#e5b08f",
    borderColor: "rgba(205, 133, 89, 0.34)",
    leaderBackground: "rgba(205, 133, 89, 0.16)",
    herdBackground: "rgba(205, 133, 89, 0.1)",
  },
  {
    token: "glacier",
    textColor: "#a7d6e7",
    borderColor: "rgba(108, 177, 204, 0.34)",
    leaderBackground: "rgba(108, 177, 204, 0.16)",
    herdBackground: "rgba(108, 177, 204, 0.1)",
  },
];

export function getHerdGroupLeaderId(session: Pick<SessionItem, "id" | "isOrchestrator" | "herdedBy">): string | null {
  if (session.isOrchestrator) return session.id;
  return session.herdedBy ?? null;
}

export function buildHerdGroupBadgeThemes(sessions: HerdGroupSession[]): Map<string, HerdGroupBadgeTheme> {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const leaderIds = new Set<string>();

  for (const session of sessions) {
    const leaderId = getHerdGroupLeaderId(session);
    if (leaderId) leaderIds.add(leaderId);
  }

  const orderedLeaderIds = Array.from(leaderIds).sort((a, b) => compareLeaderSessions(sessionsById.get(a), sessionsById.get(b), a, b));
  const usedPaletteIndexes = new Set<number>();
  const themeMap = new Map<string, HerdGroupBadgeTheme>();

  for (const leaderId of orderedLeaderIds) {
    const preferredIndex = stringHash(leaderId) % HERD_GROUP_BADGE_PALETTE.length;
    const paletteIndex = pickPaletteIndex(preferredIndex, usedPaletteIndexes);
    if (usedPaletteIndexes.size < HERD_GROUP_BADGE_PALETTE.length) {
      usedPaletteIndexes.add(paletteIndex);
    }
    themeMap.set(leaderId, HERD_GROUP_BADGE_PALETTE[paletteIndex]);
  }

  return themeMap;
}

function compareLeaderSessions(
  a: HerdGroupSession | undefined,
  b: HerdGroupSession | undefined,
  aId: string,
  bId: string,
): number {
  const aSessionNum = a?.sessionNum ?? Number.MAX_SAFE_INTEGER;
  const bSessionNum = b?.sessionNum ?? Number.MAX_SAFE_INTEGER;
  if (aSessionNum !== bSessionNum) return aSessionNum - bSessionNum;

  const aCreatedAt = a?.createdAt ?? Number.MAX_SAFE_INTEGER;
  const bCreatedAt = b?.createdAt ?? Number.MAX_SAFE_INTEGER;
  if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;

  return aId.localeCompare(bId);
}

function pickPaletteIndex(preferredIndex: number, usedPaletteIndexes: Set<number>): number {
  if (usedPaletteIndexes.size >= HERD_GROUP_BADGE_PALETTE.length) {
    return preferredIndex;
  }

  for (let offset = 0; offset < HERD_GROUP_BADGE_PALETTE.length; offset += 1) {
    const candidate = (preferredIndex + offset) % HERD_GROUP_BADGE_PALETTE.length;
    if (!usedPaletteIndexes.has(candidate)) return candidate;
  }

  return preferredIndex;
}

function stringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
