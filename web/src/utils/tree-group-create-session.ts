import type { TreeGroup } from "../types.js";
import { getTreeGroupNewSessionDefaultsKey } from "./new-session-defaults.js";

export interface TreeGroupCreateSessionModalContext {
  treeGroupId: string;
  memorySessionSpaceSlug?: string;
  newSessionDefaultsKey: string;
}

export function buildTreeGroupCreateSessionModalContext(
  treeGroupId: string,
  treeGroups: TreeGroup[],
): TreeGroupCreateSessionModalContext | null {
  const normalizedTreeGroupId = treeGroupId.trim();
  if (!normalizedTreeGroupId) return null;
  const treeGroup = treeGroups.find((group) => group.id === normalizedTreeGroupId);
  if (normalizedTreeGroupId !== "default" && !treeGroup) return null;
  return {
    treeGroupId: normalizedTreeGroupId,
    memorySessionSpaceSlug: normalizedTreeGroupId !== "default" ? treeGroup?.name : undefined,
    newSessionDefaultsKey: getTreeGroupNewSessionDefaultsKey(normalizedTreeGroupId),
  };
}
