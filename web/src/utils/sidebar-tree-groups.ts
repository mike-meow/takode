import type { TreeGroup } from "../types.js";

export function buildAuthoritativeTreeGroupsForWriteback(treeGroups: TreeGroup[]): TreeGroup[] {
  const groups: TreeGroup[] = [];
  const seen = new Set<string>();
  for (const group of treeGroups) {
    const id = group.id.trim();
    const name = group.name.trim();
    if (!id || !name || seen.has(id)) continue;
    groups.push({ id, name });
    seen.add(id);
  }
  if (!seen.has("default")) {
    groups.unshift({ id: "default", name: "Default" });
  }
  return groups;
}
