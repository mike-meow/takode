import type { QuestmasterTask } from "../types.js";
import {
  compactPhaseDocumentationGroups,
  phaseDocumentationPreview,
  summarizeQuestPhaseDocumentation,
} from "../../shared/quest-phase-documentation-summary.js";
import { getHighlightParts } from "../utils/highlight.js";

export function QuestPhaseScanLines({
  quest,
  searchText,
  max = 2,
  className = "",
}: {
  quest: QuestmasterTask;
  searchText: string;
  max?: number;
  className?: string;
}) {
  const summary = summarizeQuestPhaseDocumentation(quest);
  const groups = compactPhaseDocumentationGroups(summary, max);
  if (groups.length === 0) return null;

  return (
    <div className={`space-y-0.5 ${className}`.trim()} data-testid="quest-phase-scan-lines">
      {groups.map((group) => {
        const latestEntry = group.entries.at(-1);
        if (!latestEntry) return null;
        const meta = group.metaLabel ? ` ${group.metaLabel}` : "";
        return (
          <div key={group.key} className="truncate text-[11px] text-cc-muted">
            <span className="text-cc-muted/70">
              {group.displayLabel}
              {meta}:{" "}
            </span>
            {highlightText(compactText(phaseDocumentationPreview(latestEntry)), searchText)}
          </div>
        );
      })}
    </div>
  );
}

function compactText(text: string, max = 140): string {
  const compact = text.trim().replace(/\s+/g, " ");
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 3).trimEnd()}...`;
}

function highlightText(text: string, query: string) {
  const parts = getHighlightParts(text, query);
  return parts.map((part, index) =>
    part.matched ? (
      <mark key={index} className="rounded bg-yellow-400/20 px-0.5 text-yellow-200">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}
